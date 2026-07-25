// 260725 wp2 — three smaller sidebar defects found by reading the surface.
//
// None of them is dramatic on its own; all three leave the user somewhere they
// cannot recover from without reaching for the mouse.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('the sidebar resize drag cleans up when the pointer is cancelled', () => {
    const shell = read('public/dashboard2/src/shell/Shell.tsx');
    const drag = shell.match(/onResizeStart[\s\S]{0,1200}?\}, \[\]\)/)?.[0] ?? '';

    assert.ok(drag, 'the resize handler must exist');
    // A cancelled gesture sends no pointerup, so both the listeners and the
    // is-dragging class would survive it.
    assert.match(drag, /addEventListener\('pointercancel'/, 'a cancelled drag must still end the drag');
    assert.match(drag, /removeEventListener\('pointercancel'/, 'and must unregister itself');

    // The adjacent divider already had this right; the two should not diverge.
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');
    assert.match(workbench, /pointercancel/, 'the workbench divider keeps the same contract');
});

test('every menu-closing action returns focus to the trigger', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    assert.match(sidebar, /const dismissMenu = useCallback/, 'closing the menu should go through one place');
    const helper = sidebar.match(/const dismissMenu = useCallback[\s\S]{0,400}?\}, \[\]\)/)?.[0] ?? '';
    assert.match(helper, /menuTriggerRef\.current\?\.focus\(\)/, 'and that place must restore focus');

    // Copy, lifecycle and open-in-terminal all used to close the menu bare,
    // dropping focus onto document.body.
    const copy = sidebar.match(/const copyPath[\s\S]{0,600}?\n    \};/)?.[0] ?? '';
    assert.match(copy, /dismissMenu\(\)/, 'copy must restore focus');
    assert.equal(
        /await navigator\.clipboard\.writeText\(path\);\s*setMenuPort\(null\);/.test(copy),
        false,
        'copy must not close the menu without restoring focus',
    );
});

test('a failed copy says so instead of looking like a dead button', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const copy = sidebar.match(/const copyPath[\s\S]{0,700}?\n    \};/)?.[0] ?? '';

    assert.match(copy, /catch \(error\)/, 'the failure needs to be inspectable');
    assert.match(copy, /setInstancesError\(/, 'and surfaced, since a silent catch reads as a broken control');
});

test('a failed conversation fetch is distinguishable from an empty list', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const fetcher = sidebar.match(/async function fetchJwcConversations[\s\S]{0,900}?\n\}/)?.[0] ?? '';

    assert.ok(fetcher, 'the fetcher must exist');
    // Returning [] on a non-2xx made a failure look like "no conversations",
    // which offers no retry.
    assert.equal(/if \(!res\.ok\) return \[\];/.test(fetcher), false, 'a failed request must not masquerade as an empty list');
    assert.match(fetcher, /throw new Error/, 'it must fail loudly enough for the caller to react');
});

test('the error state the sidebar renders is actually reachable', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    // The 'error' capability had a retry branch in the render tree that nothing
    // could ever enter, because the fetch never rejected past its caller.
    assert.match(
        sidebar,
        /catch \{[\s\S]{0,400}?capability: 'error'/,
        'the caller must catch the rejection and enter the error state',
    );
});
