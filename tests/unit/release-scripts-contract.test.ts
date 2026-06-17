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

    test(`${scriptPath} delegates desktop distribution to release-triggered GitHub Actions`, () => {
        const script = read(scriptPath);

        assert.ok(
            script.includes('--with-desktop'),
            'release script must keep --with-desktop as a backward-compatible no-op',
        );
        assert.ok(
            script.includes('GitHub Actions builds desktop assets after release publication'),
            'release script must route desktop assets to GitHub Actions',
        );
        assert.ok(
            script.includes('unsigned'),
            'release notes must contain the literal "unsigned" warning for desktop artifacts',
        );
        assert.ok(
            script.includes('xattr -d com.apple.quarantine'),
            'release notes must instruct macOS users on the xattr -d com.apple.quarantine workaround',
        );
        assert.ok(
            !script.includes('npm --prefix electron run dist:mac'),
            'release script must not build desktop installers locally',
        );
        assert.ok(
            !script.includes('DESKTOP_ARTIFACTS'),
            'release script must not collect local desktop artifacts',
        );
        assert.ok(
            script.includes('gh release create'),
            'release script must invoke gh release create',
        );
    });
}

test('desktop release workflow uploads OS matrix artifacts only after GitHub release publication', () => {
    const workflow = read('.github/workflows/desktop-release.yml');

    assert.ok(workflow.includes('release:'), 'desktop workflow must be release-triggered');
    assert.ok(workflow.includes('types: [published]'), 'desktop workflow must run only after release publication');
    assert.ok(!workflow.includes('push:'), 'desktop workflow must not run on git push');
    assert.ok(workflow.includes('macos-latest'), 'desktop workflow must build macOS artifacts');
    assert.ok(workflow.includes('windows-latest'), 'desktop workflow must build Windows artifacts');
    assert.ok(workflow.includes('ubuntu-latest'), 'desktop workflow must build Linux artifacts');
    assert.ok(workflow.includes('npm --prefix electron run typecheck'), 'desktop workflow must typecheck Electron shell');
    assert.ok(workflow.includes('npm --prefix electron run build'), 'desktop workflow must build Electron shell');
    assert.ok(workflow.includes('Verify macOS packaged app JWC and app icons'), 'desktop workflow must verify the packaged macOS app before upload');
    assert.ok(workflow.includes("if: matrix.platform == 'macos'"), 'macOS final app verification must not run on Windows/Linux matrix legs');
    assert.ok(workflow.includes('npm run check:electron-dist-mac-jwc'), 'desktop workflow must validate bundled JWC in the final macOS app');
    assert.ok(workflow.includes('npm run check:app-icons'), 'desktop workflow must validate app icon assets before uploading macOS artifacts');
    assert.ok(workflow.includes('CSC_IDENTITY_AUTO_DISCOVERY: false'), 'desktop workflow must keep unsigned mac builds explicit');
    assert.ok(workflow.includes('gh release upload'), 'desktop workflow must upload artifacts to the existing release');
    assert.ok(workflow.includes('--clobber'), 'desktop workflow reruns must replace stale release assets');
});
