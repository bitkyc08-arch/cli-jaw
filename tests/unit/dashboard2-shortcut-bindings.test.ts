// 260725 wp1 — the one production shortcut binding.
//
// focusNotes is the only action wired in this phase. The binding has to live
// below AppScopeProvider because ManagerShortcutProvider sits above it in
// main.tsx, so the provider itself cannot reach app scope.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('W1: focusNotes is registered by a binding mounted under app scope', () => {
    const bindings = read('public/dashboard2/src/shell/DashboardShortcutBindings.tsx');

    assert.ok(bindings.includes("registerHandler('focusNotes'"), 'focusNotes must actually be registered');
    assert.ok(bindings.includes('useAppScope'), 'the binding needs app scope to open the panel');
    assert.ok(bindings.includes('useManagerShortcuts'), 'and the shortcut registry to bind against');
});

test('W2: the handler opens the notes panel with a complete panel input', () => {
    const bindings = read('public/dashboard2/src/shell/DashboardShortcutBindings.tsx');
    const call = bindings.match(/openPanel\(\{[^}]*\}\)/)?.[0] ?? '';

    assert.ok(call, 'the handler must call openPanel');
    // OpenPanelInput requires type, key and title; keepAlive keeps the panel warm.
    for (const field of ['type:', 'key:', 'title:']) {
        assert.ok(call.includes(field), `openPanel input must carry ${field} — a partial input silently does nothing`);
    }
    assert.ok(call.includes("type: 'notes'"), 'and it must open the notes panel');
});

test('W3: the binding returns a cleanup so the chord passes through again after unmount', () => {
    const bindings = read('public/dashboard2/src/shell/DashboardShortcutBindings.tsx');

    // registerHandler returns an unsubscribe; returning it straight from the
    // effect is what lets the passthrough fix take over again on unmount.
    assert.match(
        bindings,
        /useEffect\(\(\)\s*=>\s*shortcuts\.registerHandler\(/,
        'the effect must return the unregister function, otherwise the handler leaks and the key stays captured',
    );
});

test('W1b: the binding is mounted in the app tree', () => {
    const app = read('public/dashboard2/src/App.tsx');
    assert.ok(app.includes('DashboardShortcutBindings'), 'an unmounted binding registers nothing');
});
