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
    const bootstrap = read('public/dashboard2/src/theme-bootstrap.ts');
    const themeModuleIndex = html.indexOf('src="/dashboard2/src/theme-bootstrap.ts"');
    const appModuleIndex = html.indexOf('src="/dashboard2/src/main.tsx"');

    assert.ok(themeModuleIndex >= 0, 'dashboard2 must load the self-hosted theme bootstrap module');
    assert.ok(themeModuleIndex < appModuleIndex, 'theme bootstrap must run before the application module');
    assert.ok(bootstrap.includes("localStorage.getItem('jaw.uiTheme')"));
    assert.ok(bootstrap.includes("saved === 'dark'"));
    assert.ok(bootstrap.includes("saved === 'light'"));
    assert.ok(bootstrap.includes("saved === 'auto'"));
    assert.ok(bootstrap.includes("setAttribute('data-theme', theme)"));
    assert.ok(bootstrap.includes("setAttribute('data-theme', 'auto')"));
});

test('dashboard2 shortcuts expose the source-aware dispatch entry point', () => {
    const shortcuts = read('public/dashboard2/src/providers/shortcut-provider.tsx');

    assert.match(shortcuts, /dispatch\(action: ShortcutAction, source: ShortcutSource\): void/);
    assert.ok(shortcuts.includes("dispatch(action, 'dom')"), 'DOM keydown must use the shared dispatch entry point');
    assert.ok(shortcuts.includes('registerHandler(action: ShortcutAction'));
});
