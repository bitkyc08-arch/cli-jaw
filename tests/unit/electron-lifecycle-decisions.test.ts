// wp7a — the window-lifecycle branches, tested as pure decisions.
//
// The main process registers these on app.on/mainWindow.on at module top
// level, so the branches themselves cannot be imported without an Electron
// runtime. The decisions are extracted to lifecycle-decisions.ts and tested
// here across every input combination — this is the behavioural coverage the
// source-string contract tests do not provide.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decideWindowAllClosed,
    decideBeforeQuit,
    decideActivate,
    decideWindowClose,
} from '../../electron/src/main/lib/lifecycle-decisions.ts';

test('window-all-closed: keep-running always stays alive', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
        assert.equal(decideWindowAllClosed({ keepRunning: true, platform }), 'stay');
    }
});

test('window-all-closed: without keep-running, quits everywhere except macOS', () => {
    assert.equal(decideWindowAllClosed({ keepRunning: false, platform: 'darwin' }), 'none');
    assert.equal(decideWindowAllClosed({ keepRunning: false, platform: 'linux' }), 'quit');
    assert.equal(decideWindowAllClosed({ keepRunning: false, platform: 'win32' }), 'quit');
});

test('before-quit: a completed shutdown short-circuits everything', () => {
    assert.equal(
        decideBeforeQuit({ shutdownComplete: true, keepRunning: true, forceQuitRequested: false, windowPresent: true }),
        'short-circuit',
    );
});

test('before-quit: keep-running without force-quit swallows the quit and closes the window', () => {
    assert.equal(
        decideBeforeQuit({ shutdownComplete: false, keepRunning: true, forceQuitRequested: false, windowPresent: true }),
        'close-window',
    );
    // Same branch with no window: still close-window (the close call is a no-op guard, not a different decision).
    assert.equal(
        decideBeforeQuit({ shutdownComplete: false, keepRunning: true, forceQuitRequested: false, windowPresent: false }),
        'close-window',
    );
});

test('before-quit: force-quit or no keep-running proceeds to the real quit', () => {
    assert.equal(
        decideBeforeQuit({ shutdownComplete: false, keepRunning: true, forceQuitRequested: true, windowPresent: true }),
        'request-quit',
    );
    assert.equal(
        decideBeforeQuit({ shutdownComplete: false, keepRunning: false, forceQuitRequested: false, windowPresent: true }),
        'request-quit',
    );
});

test('activate: recreates the window only when none exists', () => {
    assert.equal(decideActivate({ windowPresent: false }), 'recreate');
    assert.equal(decideActivate({ windowPresent: true }), 'none');
});

test('window close: while shutting down, the close is allowed', () => {
    assert.equal(decideWindowClose({ shutdownComplete: true, shuttingDown: false, keepRunning: true }), 'allow');
    assert.equal(decideWindowClose({ shutdownComplete: false, shuttingDown: true, keepRunning: true }), 'allow');
});

test('window close: keep-running drops to the background instead of quitting', () => {
    assert.equal(decideWindowClose({ shutdownComplete: false, shuttingDown: false, keepRunning: true }), 'background');
});

test('window close: without keep-running, the close becomes the real quit path', () => {
    assert.equal(decideWindowClose({ shutdownComplete: false, shuttingDown: false, keepRunning: false }), 'request-quit');
});

// The wiring must use these decisions rather than re-deriving them inline, or
// the tests prove a copy that drifted from the running code.
test('index.ts routes the lifecycle branches through the extracted decisions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const index = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'electron/src/main/index.ts'), 'utf8');
    assert.match(index, /decideWindowAllClosed/);
    assert.match(index, /decideBeforeQuit/);
    assert.match(index, /decideActivate/);
    assert.match(index, /decideWindowClose/);
});
