import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

for (const scriptPath of ['scripts/release.sh', 'scripts/release-preview.sh']) {
    test(`${scriptPath} validates Electron shell before publishing`, () => {
        const script = read(scriptPath);

        assert.ok(script.includes('run_electron_release_checks'), 'release script must define and call Electron release checks');
        assert.ok(script.includes('npm run check:electron-no-native'), 'release script must keep npm package Electron-free');
        assert.ok(script.includes('npm --prefix electron run typecheck'), 'release script must typecheck Electron shell');
        assert.ok(script.includes('npm --prefix electron run build'), 'release script must build Electron shell');
        assert.ok(script.includes('ELECTRON_RELEASE_NOTES'), 'release script must include Electron status in GitHub release notes');
        assert.ok(script.includes('Desktop / Electron'), 'GitHub release notes must include a Desktop / Electron section');
    });

    test(`${scriptPath} supports unsigned desktop distribution via --with-desktop`, () => {
        const script = read(scriptPath);

        assert.ok(script.includes('--with-desktop'), 'release script must accept --with-desktop flag');
        assert.ok(script.includes('WITH_DESKTOP'), 'release script must track --with-desktop state');
        assert.ok(
            script.includes('CSC_IDENTITY_AUTO_DISCOVERY=false'),
            'release script must disable Apple code-signing auto-discovery for unsigned builds',
        );
        assert.ok(
            script.includes('npm --prefix electron run dist:mac'),
            'release script must invoke Electron dist:mac when --with-desktop is on',
        );
        assert.ok(
            script.includes('unsigned'),
            'release notes must contain the literal "unsigned" warning when desktop artifacts ship',
        );
        assert.ok(
            script.includes('xattr -d com.apple.quarantine'),
            'release notes must instruct macOS users on the xattr -d com.apple.quarantine workaround',
        );
        assert.ok(
            script.includes('electron/dist'),
            'release script must reference electron/dist artifacts for gh release upload',
        );
        assert.ok(
            script.includes('gh release create'),
            'release script must invoke gh release create',
        );
    });
}
