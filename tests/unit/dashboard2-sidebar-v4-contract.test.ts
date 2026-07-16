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

test('dashboard2 sidebar v4 keeps the canonical glass material', () => {
    const css = read('public/dashboard2/src/styles/sidebar-v4.css');

    assert.ok(css.includes('linear-gradient('), 'sidebar must use the v4 glass gradient');
    assert.ok(css.includes('rgba(28, 28, 32, 0.72) 0%'));
    assert.ok(css.includes('rgba(21, 21, 23, 0.90) 100%'));
    assert.ok(css.includes('backdrop-filter: blur(48px) saturate(1.3)'));
    assert.ok(css.includes('-webkit-backdrop-filter: blur(48px) saturate(1.3)'));
});

test('dashboard2 sidebar v4 exposes mode switcher, two-line instances, and footer', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    for (const className of [
        'd2-mode-switcher',
        'd2-mode-button',
        'd2-mode-badge',
        'd2-instance-dot',
        'd2-instance-copy',
        'd2-instance-port',
        'd2-instance-trail',
        'd2-sidebar-footer-v4',
        'd2-sidebar-brand',
    ]) {
        assert.ok(sidebar.includes(className), `Sidebar must expose ${className}`);
    }
    assert.ok(sidebar.includes("type SidebarMode = 'jaw' | 'jwc'"));
    assert.ok(sidebar.includes('No jwc conversations'), 'jwc v1 must render its local empty state');
    assert.ok(sidebar.includes('>JAW</span>'), 'footer must retain the JAW brand');
    assert.ok(sidebar.includes('<ThemeToggle />'), 'footer must retain the existing theme control');
});

test('dashboard2 sidebar v4 stays independent from jwc and theme resolution internals', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const importLines = sidebar.split('\n').filter((line) => /^\s*import\b/.test(line));

    assert.equal(importLines.filter((line) => /jwc/i.test(line)).length, 0, 'Sidebar must not import jwc v1 data');
    assert.equal(sidebar.includes('colorScheme'), false, 'Sidebar must not mutate the resolved color scheme');
    assert.ok(sidebar.includes('theme.setMode(next)'), 'ThemeToggle must keep using preference state');
});

test('dashboard2 sidebar v4 wires lifecycle actions through the manager origin', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const api = read('public/dashboard2/src/providers/api-provider.tsx');

    assert.ok(sidebar.includes('useInstanceLifecycle'));
    assert.ok(sidebar.includes('lifecycleControl.run(action, instance)'));
    assert.ok(api.includes('`/api/dashboard/lifecycle/${action}`'));
    assert.ok(api.includes("method: 'POST'"));
    assert.ok(api.includes('body: JSON.stringify({ port, ...(home !== undefined ? { home } : {}) })'));
    assert.ok(sidebar.includes('lifecycle?.canStart'));
    assert.ok(sidebar.includes('lifecycle?.canStop'));
    assert.equal(sidebar.includes('`/i/${instance.port}'), false, 'lifecycle actions must not bypass the manager origin');
});

test('dashboard2 sidebar v4 hover actions remain keyboard reachable', () => {
    const css = read('public/dashboard2/src/styles/sidebar-v4.css');

    assert.ok(css.includes('display: inline-flex'));
    assert.ok(css.includes('opacity: 0'));
    assert.ok(css.includes('visibility: hidden'));
    assert.ok(css.includes('.d2-instance-row:focus-within .d2-instance-control'));
    assert.ok(css.includes('.d2-instance-row:focus-within .d2-instance-more'));
    assert.ok(css.includes('.d2-instance-control:focus-visible'));
    assert.ok(css.includes('.d2-instance-control.is-always-visible'));
    assert.ok(css.includes('pointer-events: auto'));
    assert.equal(css.includes('display: none;\n    width: 22px'), false);
});

test('dashboard2 lifecycle rows expose progress and retry semantics to assistive technology', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    assert.ok(sidebar.includes('aria-busy={lifecycleBusy || undefined}'));
    assert.ok(sidebar.includes('aria-hidden="true"'));
    assert.ok(sidebar.includes('role="status"'));
    assert.ok(sidebar.includes('role="alert"'));
    assert.ok(sidebar.includes("lifecycleError ? 'Retry'"));
    assert.ok(sidebar.includes('disabled={!lifecycleAllowed || lifecycleBlocked}'));
});
