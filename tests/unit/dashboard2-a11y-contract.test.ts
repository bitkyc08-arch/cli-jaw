import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(path: string): string {
    return readSource(join(ROOT, path), 'utf8');
}

test('090 icon-only shell controls have names and decorative icons stay hidden', () => {
    const icon = read('public/dashboard2/src/shell/Icon.tsx');
    const sources = [
        read('public/dashboard2/src/shell/Sidebar.tsx'),
        read('public/dashboard2/src/shell/Workbench.tsx'),
        read('public/dashboard2/src/shell/SidePane.tsx'),
        read('public/dashboard2/src/shell/SettingsModal.tsx'),
        read('public/dashboard2/src/chat/composer/ComposerFooter.tsx'),
    ].join('\n');

    assert.match(icon, /className="d2-icon"[\s\S]*aria-hidden="true"/);
    for (const name of [
        'Close sidebar', 'Settings', 'Open settings', 'Open side pane',
        'Close side pane', 'Open panel', 'Close settings',
    ]) {
        assert.ok(sources.includes(`aria-label="${name}"`) || sources.includes(`'${name}'`), `${name} has an accessible name`);
    }
    assert.match(sources, /aria-label=\{`More actions for \$\{instanceName\(instance\)\}`\}/);
    assert.match(sources, /aria-label=\{`Close \$\{panel\.title\}`\}/);
});

test('090 sidebar and side-pane tablists bind panels and expose one roving tabstop', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');

    assert.match(sidebar, /role="tablist" aria-label="Sidebar mode"/);
    assert.equal((sidebar.match(/aria-controls="d2-sidebar-panel"/g) ?? []).length, 2);
    assert.match(sidebar, /tabIndex=\{mode === 'jaw' \? 0 : -1\}/);
    assert.match(sidebar, /tabIndex=\{mode === 'jwc' \? 0 : -1\}/);
    assert.match(sidebar, /role="tabpanel" id="d2-sidebar-panel" aria-labelledby=\{activeTabId\}/);
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(sidebar.includes(`case '${key}'`));

    assert.match(sidePane, /role="tablist" aria-label="Open side panels"/);
    assert.match(sidePane, /aria-controls=\{`d2-pane-panel-\$\{panel\.id\}`\}/);
    assert.match(sidePane, /tabIndex=\{panel\.id === activePanelId \? 0 : -1\}/);
    assert.match(sidePane, /role="tabpanel" id=\{`d2-pane-panel-\$\{panel\.id\}`\} aria-labelledby=\{`d2-pane-tab-\$\{panel\.id\}`\}/);
    assert.match(sidePane, /inert=\{!active\}/);
});

test('090 workbench resize separator reports values and supports precise and coarse keyboard increments', () => {
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');

    assert.match(workbench, /className="d2-workbench-divider-drag"[\s\S]*role="separator"/);
    assert.match(workbench, /aria-orientation="vertical"/);
    assert.match(workbench, /aria-valuenow=\{paneWidth\}/);
    assert.match(workbench, /aria-valuemin=\{PANE_MIN\}/);
    assert.match(workbench, /aria-valuemax=\{getPaneMax\(\)\}/);
    assert.match(workbench, /const step = e\.shiftKey \? 50 : 10/);
    assert.match(workbench, /case 'ArrowLeft':[\s\S]*paneWidth \+ step/);
    assert.match(workbench, /case 'ArrowRight':[\s\S]*paneWidth - step/);
    assert.match(workbench, /case 'Home':[\s\S]*next = PANE_MIN/);
    assert.match(workbench, /case 'End':[\s\S]*next = paneMax/);
});

test('090 modal, menu, and side-pane close paths restore focus to their trigger', () => {
    const modal = read('public/dashboard2/src/shell/SettingsModal.tsx');
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');

    assert.match(modal, /const previouslyFocused = document\.activeElement/);
    assert.match(modal, /previouslyFocused instanceof HTMLElement\) previouslyFocused\.focus\(\)/);
    assert.match(sidebar, /menuTriggerRef\.current\?\.focus\(\)/);
    assert.match(workbench, /focusWasInsidePane[\s\S]*toggleButtonRef\.current\?\.focus\(\)/);
});

test('090 dynamic announcements retain a single owner per lifecycle surface', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const chat = read('public/dashboard2/src/chat/ChatView.tsx');
    const pending = read('public/dashboard2/src/chat/pending/PendingQueue.tsx');

    assert.doesNotMatch(
        sidebar,
        /role="tabpanel"[^>]*aria-live=/,
        'the sidebar tabpanel must not re-announce nested lifecycle status regions',
    );
    assert.equal((chat.match(/aria-live="polite"/g) ?? []).length, 1, 'ChatView owns one action announcement region');
    assert.equal((pending.match(/aria-live="polite"/g) ?? []).length, 1, 'pending queue keeps one status owner in its component');
    assert.doesNotMatch(pending, /snapshot\.rows\.map[\s\S]*d2-pending-status" aria-live=/, 'pending rows do not multiply live regions');
});
