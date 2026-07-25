// 260725 wp2 — sidebar keyboard reachability and collapsed-state containment.
//
// Two defects found by the QA harness sweep:
//
// 1. The instance overflow buttons animated `visibility` on reveal. A
//    visibility:hidden element is not focusable, so a fast Tab landed before the
//    first style commit and skipped every one of them. Keyboard users could not
//    open the instance context menu at all unless they happened to tab slowly.
// 2. Closing the sidebar folded it to a zero-width grid track but left it
//    mounted and focusable, so ten consecutive Tab presses disappeared into a
//    1px-wide strip.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function block(css: string, selector: string): string {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `${selector} must exist`);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open, close);
}

test('overflow controls expose focus immediately and only delay hiding', () => {
    const css = read('public/dashboard2/src/styles/sidebar-v4.css');
    const base = block(css, '.d2-instance-control,\n.d2-instance-more {');

    // The whole point: visibility must not animate on the way in.
    assert.equal(
        /transition:[^;]*visibility\s+120ms/.test(base),
        false,
        'animating visibility on reveal makes focusability race the first style commit',
    );
    assert.match(
        base,
        /visibility\s+0s\s+linear\s+120ms/,
        'visibility should switch instantly and only be delayed when hiding, which preserves the fade-out',
    );
});

test('every reveal selector cancels the hide delay', () => {
    const css = read('public/dashboard2/src/styles/sidebar-v4.css');

    // Without transition-delay: 0s on the reveal rules, the delayed visibility
    // would apply in both directions and the race would come back.
    const revealBlock = block(css, '.d2-instance-row:hover .d2-instance-control,');
    assert.match(revealBlock, /transition-delay:\s*0s/, 'hover/focus reveal must cancel the delay');

    const alwaysVisible = block(css, '.d2-instance-control.is-always-visible {');
    assert.match(alwaysVisible, /transition-delay:\s*0s/, 'always-visible controls must not inherit the hide delay');
});

test('a collapsed sidebar is inert so focus cannot fall into it', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    assert.match(sidebar, /collapsed\?:\s*boolean/, 'Sidebar must know whether the shell folded it');
    assert.match(sidebar, /inert=\{collapsed\}/, 'a zero-width sidebar must leave the tab order');
    assert.match(sidebar, /aria-hidden=\{collapsed\}/, 'and must leave the accessibility tree with it');
});

test('closing the sidebar hands focus to the button that reopens it', () => {
    const shell = read('public/dashboard2/src/shell/Shell.tsx');
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');

    assert.match(shell, /collapsed=\{sidebarCollapsed\}/, 'Shell must pass the collapsed state down');

    // The close button is inside the subtree that becomes inert, so focus has to
    // be moved somewhere reachable or it is stranded.
    assert.match(shell, /d2-workbench-side-toggle-open/, 'Shell must target the reopen button');
    assert.match(shell, /\.focus\(\)/, 'and actually move focus to it');
    assert.match(
        workbench,
        /d2-workbench-side-toggle-open/,
        'the reopen button must carry the class Shell targets, and it lives outside the sidebar so this cannot trap focus',
    );
});
