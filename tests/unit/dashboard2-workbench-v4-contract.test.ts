import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

test('dashboard2 workbench v4 uses the full-height three-column side-pane grid', () => {
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.match(
        css,
        /\.d2-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+0\s+0/s,
    );
    assert.match(
        css,
        /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+1px\s+var\(--d2-pane-w,\s*380px\)/,
    );
    assert.match(css, /\.d2-workbench-divider-drag\s*\{[^}]*height:\s*100%/s);
    assert.match(css, /\.d2-workbench-divider-drag\s*\{[^}]*background:\s*var\(--div-color\)/s);
});

test('dashboard2 workbench v4 owns split 48px headers and preserves the ChatView mount', () => {
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.ok(workbench.includes('d2-workbench-left-header'));
    assert.ok(workbench.includes('<SidePane open={sidePaneOpen} onClose={closeSidePaneWithFocusRestore} />'));
    assert.ok(workbench.includes("style={{ display: sidePaneOpen ? undefined : 'none' }}"));
    assert.ok(workbench.includes('inert={!sidePaneOpen}'));
    assert.ok(workbench.includes('aria-hidden={!sidePaneOpen}'));
    assert.ok(workbench.includes('<ChatView scope={selected} />'));
    assert.match(css, /\.d2-workbench-left-header,\s*\n\.d2-side-pane-header\s*\{[^}]*height:\s*48px/s);
});

test('dashboard2 workbench header resolves the selected instance name with a port fallback', () => {
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');

    assert.ok(workbench.includes('api.fetchInstances()'), 'workbench must load instance names on mount');
    assert.ok(workbench.includes('instance.label?.trim()'), 'instance label must be the first name choice');
    assert.match(workbench, /workingDir\?\.replace\(\/\[\\\\\/\]\+\$\//);
    assert.ok(workbench.includes('instanceNames.get(selected.port) ?? `Port ${selected.port}`'));
});

test('dashboard2 side pane keeps all seven registry tabs and hidden keep-alive slots', () => {
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.ok(sidePane.includes('<h2>Open tab</h2>'));
    assert.deepEqual(
        [...sidePane.matchAll(/id:\s*'(terminal|browser|files|code|notes|board|reminders)'/g)].map((match) => match[1]),
        ['terminal', 'browser', 'files', 'code', 'notes', 'board', 'reminders'],
    );
    assert.ok(sidePane.includes('mountedTabs.has(desc.id)'));
    assert.ok(sidePane.includes("style={{ display: isVisible ? undefined : 'none' }}"));
    assert.ok(sidePane.includes('inert={!isVisible}'));
    assert.ok(sidePane.includes('aria-hidden={!isVisible}'));
    assert.match(sidePane, /\{renderTabs\(\)\}\s*\{activeSidePaneTab === null \? \(/s);
    assert.match(css, /\.d2-side-pane-picker-button\s*\{[^}]*height:\s*52px/s);
});

test('dashboard2 side pane gates lifecycle, restores focus, and preserves the chat minimum', () => {
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');

    assert.ok(sidePane.includes('if (!open) return;'));
    assert.ok(sidePane.includes('<TabContent tabId={desc.id} active={isVisible} />'));
    assert.ok(workbench.includes('toggleButtonRef.current?.focus()'));
    assert.ok(workbench.includes('const CHAT_MIN = 280;'));
    assert.ok(workbench.includes('const DIVIDER_WIDTH = 1;'));
    assert.ok(workbench.includes('rect.width - CHAT_MIN - DIVIDER_WIDTH'));
    assert.doesNotMatch(workbench, /PANE_MAX_RATIO/);
});

test('dashboard2 workbench v4 does not hardcode the legacy instance label', () => {
    const sources = [
        read('public/dashboard2/src/shell/Workbench.tsx'),
        read('public/dashboard2/src/shell/SidePane.tsx'),
        read('public/dashboard2/src/styles/workbench-v4.css'),
    ].join('\n').toLowerCase();

    assert.equal((sources.match(/jwc/g) ?? []).length, 0);
});
