import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The point of the refactor is the ABSENCE of duplicated detection, so these
 * assertions read the source rather than only exercising behavior.
 *
 * src/lib/tui/terminal.ts is deliberately excluded: it is a vendored bundle
 * outside the root tsconfig whose `$env` is a function, not an env object.
 * See devlog/_plan/260805_windows_native_detection/020_detector_refactor.md.
 */
const DELEGATING_SITES = [
    'src/core/browser-open.ts',
    'src/core/browser-open-default.ts',
    'src/browser/connection.ts',
    'bin/commands/doctor.ts',
];

test('no site re-derives WSL state from raw env vars', () => {
    for (const relative of DELEGATING_SITES) {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        // Importing the module is not enough — the site must actually call it.
        assert.match(
            source,
            /from\s+'[^']*platform-kind\.js'/,
            `${relative} must import the resolver`,
        );
        assert.match(source, /\bisWsl\s*\(/, `${relative} must call isWsl()`);
        assert.doesNotMatch(
            source,
            /WSL_DISTRO_NAME|WSL_INTEROP|WSLENV/,
            `${relative} must not test WSL env vars directly`,
        );
    }
});

test('WSLENV appears nowhere in the resolver decision path', () => {
    const resolver = fs.readFileSync(path.join(root, 'src/core/platform-kind.ts'), 'utf8');
    // Strip comments: the explanatory note about WHY WSLENV is excluded should
    // stay, but it must never re-enter executable code.
    const executable = resolver
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(executable, /WSLENV/);
});

test('no production site reads /proc/version directly any more', () => {
    for (const relative of DELEGATING_SITES) {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.doesNotMatch(
            source,
            /\/proc\/version/,
            `${relative} must delegate kernel probing to the resolver`,
        );
    }
});
