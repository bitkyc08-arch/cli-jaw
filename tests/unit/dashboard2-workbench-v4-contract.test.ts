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
        /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+1px\s+minmax\(340px,\s*\.45fr\)/,
    );
    assert.match(css, /\.d2-workbench-divider\s*\{[^}]*height:\s*100%/s);
    assert.match(css, /\.d2-workbench-divider\s*\{[^}]*background:\s*var\(--div-color\)/s);
});

test('dashboard2 workbench v4 owns split 48px headers and preserves the ChatView mount', () => {
    const workbench = read('public/dashboard2/src/shell/Workbench.tsx');
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.ok(workbench.includes('d2-workbench-left-header'));
    assert.ok(workbench.includes('<SidePane onClose={closeSidePane} />'));
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

test('dashboard2 side pane exposes picker, tab reset, and placeholder contracts', () => {
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');
    const css = read('public/dashboard2/src/styles/workbench-v4.css');

    assert.ok(sidePane.includes('<h2>Open tab</h2>'));
    assert.deepEqual(
        [...sidePane.matchAll(/id:\s*'(terminal|browser|files)'/g)].map((match) => match[1]),
        ['terminal', 'browser', 'files'],
    );
    assert.ok(sidePane.includes('onClick={() => setActiveTab(null)}'));
    assert.ok(sidePane.includes('Terminal output will appear here'));
    assert.match(css, /\.d2-side-pane-picker-button\s*\{[^}]*height:\s*52px/s);
});

test('dashboard2 workbench v4 does not hardcode the legacy instance label', () => {
    const sources = [
        read('public/dashboard2/src/shell/Workbench.tsx'),
        read('public/dashboard2/src/shell/SidePane.tsx'),
        read('public/dashboard2/src/styles/workbench-v4.css'),
    ].join('\n').toLowerCase();

    assert.equal((sources.match(/jwc/g) ?? []).length, 0);
});
