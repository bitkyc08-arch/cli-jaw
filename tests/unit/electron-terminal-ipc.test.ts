import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const terminalMain = readFileSync('electron/src/main/lib/terminal/index.ts', 'utf8');

test('terminal:create rejects an explicitly invalid cwd instead of falling back home', () => {
    assert.match(terminalMain, /const requestedCwd = opts\?\.cwd/);
    assert.match(
        terminalMain,
        /if \(requestedCwd !== undefined && !isAllowedCwd\(requestedCwd\)\) \{\s*return \{ ok: false, error: 'cwd not allowed' \};\s*\}/,
    );
    assert.match(terminalMain, /const cwd = requestedCwd \?\? homedir\(\)/);
    assert.doesNotMatch(terminalMain, /cwd = homedir\(\)/, 'an explicit rejected cwd must never be silently replaced');
    assert.match(terminalMain, /isWithinHome\(cwd\)/);
    assert.match(terminalMain, /statSync\(resolve\(cwd\)\)\.isDirectory\(\)/);
});

test('terminal:create permits omitted cwd home and emits exit events', () => {
    assert.match(terminalMain, /const cwd = requestedCwd \?\? homedir\(\)/);
    assert.match(terminalMain, /pty\.onExit\(\(\{ exitCode \}\) => \{/);
    assert.match(terminalMain, /sessions\.delete\(id\)/);
    assert.match(terminalMain, /win\.webContents\.send\('terminal:exit', id, exitCode\)/);
});
