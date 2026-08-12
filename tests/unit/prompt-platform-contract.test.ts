// #308: the prompts must teach the RIGHT Computer Use API per platform.
//
// macOS is app-scoped (`get_app_state`), Windows is window-scoped
// (`list_windows` -> `get_window_state`). Telling a Windows agent to call
// `get_app_state` produces `sky.get_app_state is not a function`, so the
// Windows guidance must never mention it.
//
// Note the scoping: the macOS assertions are global (those tools genuinely
// belong in the doc), while the Windows prohibitions are checked ONLY inside
// the Windows section. A global negative would break the macOS contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = (name: string) => path.resolve(here, '../../src/prompt/templates/', name);
const read = (name: string) => fs.readFileSync(T(name), 'utf8');

/** Lines that talk about Windows, used for the "never instruct X" checks. */
function windowsLines(source: string): string {
    return source
        .split('\n')
        .filter((line) => /windows/i.test(line))
        .join('\n');
}

for (const file of ['a1-system.md', 'control-system.md', 'employee.md']) {
    test(`PLAT-001 (${file}): teaches the Windows window-scoped sequence`, () => {
        const src = read(file);
        assert.match(src, /list_windows\(\)/, 'Windows discovery call must be documented');
        assert.match(src, /get_window_state/, 'Windows state read must be documented');
    });

    test(`PLAT-002 (${file}): never tells Windows to use the macOS-only calls`, () => {
        const windows = windowsLines(read(file));
        assert.ok(windows.length > 0, 'the file must actually mention Windows');
        // "no get_app_state" / "does not exist" statements are allowed; what is
        // banned is an instruction to CALL it on Windows.
        assert.doesNotMatch(windows, /Windows[^.\n]*(?:call|use|start with|first action is)\s+`?get_app_state/i);
        assert.doesNotMatch(windows, /Windows[^.\n]*(?:call|use)\s+`?select_text/i);
    });

    test(`PLAT-003 (${file}): keeps the macOS app-scoped contract`, () => {
        const src = read(file);
        assert.match(src, /get_app_state/, 'macOS state-first call must remain');
    });
}

test('PLAT-004: a1-system documents the two Windows results that look like success', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /list_apps\(\)[^\n]*(?:not a health|dead pipe|never[^\n]*health)/i,
        'list_apps must be marked as NOT a health signal');
    assert.match(a1, /not on the pipe/i,
        'an empty window list must be described as a pipe/session precondition failure');
    assert.match(a1, /node_repl/, 'the node_repl requirement must be stated');
});

test('PLAT-005: a1-system states the Windows host preconditions', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /logged-on/i, 'the logged-on session requirement must be stated');
    assert.match(a1, /config\.toml/, 're-reading config.toml after launch must be stated');
    assert.match(a1, /pipe/i, 'the named pipe must be explained');
});

test('PLAT-006: the sandbox bypass is named honestly and never auto-applied', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /dangerously-bypass-approvals-and-sandbox/,
        'the actual flag must be named, not euphemized');
    assert.match(a1, /never adds it automatically|never adds or persists/i,
        'the prompt must state cli-jaw does not add it for the user');
    assert.match(a1, /\bboth\b/i, 'it must be stated that BOTH approvals and sandbox are disabled');
});

test('PLAT-007: Linux and WSL remain denied', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /Linux\/WSL|WSL/, 'WSL must still be addressed');
    assert.match(a1, /no Computer Use host|CDP only|only the \*\*CDP browser path\*\*/i,
        'Linux/WSL must be pointed at CDP');
});
