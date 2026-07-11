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

function arrayMembers(source: string, declaration: string): string[] {
    const match = source.match(new RegExp(`${declaration}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
    assert.ok(match, `${declaration} array must exist`);
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]).sort();
}

test('dashboard2 preferences use PATCH behind a hydration save barrier', () => {
    const preferences = read('public/dashboard2/src/providers/preferences-provider.tsx');
    const guardIndex = preferences.indexOf('if (!hydratedRef.current)');
    const patchIndex = preferences.indexOf('client.patch(patch)');

    assert.ok(preferences.includes("method: 'PATCH'"), 'registry writes must use PATCH');
    assert.equal(preferences.includes("method: 'PUT'"), false, 'registry writes must never use PUT');
    assert.ok(guardIndex >= 0, 'preferences save must check the hydration barrier');
    assert.ok(patchIndex > guardIndex, 'hydration guard must run before registry save');
});

test('dashboard2 keymap matches the server navigation shortcut action set', () => {
    const preferences = read('public/dashboard2/src/providers/preferences-provider.tsx');
    const registry = read('src/manager/registry.ts');

    assert.deepEqual(
        arrayMembers(preferences, 'SHORTCUT_ACTIONS'),
        arrayMembers(registry, 'SHORTCUT_ACTIONS'),
        'dashboard2 and registry shortcut action sets must stay identical',
    );
    assert.equal(arrayMembers(preferences, 'SHORTCUT_ACTIONS').length, 5);
});

test('dashboard2 boots the saved theme before the application module', () => {
    const html = read('public/dashboard2/index.html');
    const themeReadIndex = html.indexOf("localStorage.getItem('jaw.uiTheme')");
    const appModuleIndex = html.indexOf('src="/dashboard2/src/main.tsx"');

    assert.ok(themeReadIndex >= 0, 'inline theme boot must read jaw.uiTheme');
    assert.ok(themeReadIndex < appModuleIndex, 'theme boot must run before the application module');
    assert.ok(html.includes("setAttribute('data-theme', saved)"));
});

test('dashboard2 shortcuts expose the source-aware dispatch entry point', () => {
    const shortcuts = read('public/dashboard2/src/providers/shortcut-provider.tsx');

    assert.match(shortcuts, /dispatch\(action: ShortcutAction, source: ShortcutSource\): void/);
    assert.ok(shortcuts.includes("dispatch(action, 'dom')"), 'DOM keydown must use the shared dispatch entry point');
    assert.ok(shortcuts.includes('registerHandler(action: ShortcutAction'));
});
