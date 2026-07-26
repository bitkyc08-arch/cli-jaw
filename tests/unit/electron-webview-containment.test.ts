// wp7b — the webview containment: every attached webview is sandboxed and its
// URL is allowlisted, and the popover's preload exposes nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('will-attach-webview forces the sandbox webPreferences on every attach', () => {
    const src = readFileSync(join(ROOT, 'electron/src/main/index.ts'), 'utf8');
    const attach = src.slice(src.indexOf("will-attach-webview"), src.indexOf('render-process-gone'));
    // The URL allowlist runs first and prevents the attach entirely.
    assert.ok(attach.includes('isAllowedEmbeddedBrowserUrl'), 'URL allowlist enforced');
    assert.ok(attach.includes('event.preventDefault()'), 'disallowed URL is prevented');
    // Every one of the containment preferences is forced.
    assert.ok(attach.includes('delete webPreferences.preload'), 'no preload in the guest');
    assert.ok(attach.includes('webPreferences.nodeIntegration = false'));
    assert.ok(attach.includes('webPreferences.contextIsolation = true'));
    assert.ok(attach.includes('webPreferences.sandbox = true'));
    assert.ok(attach.includes('webPreferences.webSecurity = true'));
    assert.ok(attach.includes('webPreferences.allowRunningInsecureContent = false'));
    assert.ok(attach.includes('webPreferences.plugins = false'));
    assert.ok(attach.includes('EMBEDDED_BROWSER_PARTITION'), 'guest session is partitioned');
});

test('the embedded-browser URL policy is an explicit allowlist, not any-http', () => {
    const src = readFileSync(join(ROOT, 'electron/src/main/lib/navigation-policy.ts'), 'utf8');
    assert.ok(src.includes('normalizeExternalOpenUrl'), 'policy function exists');
    // It must reject credentials-in-URL and non-http(s) schemes.
    assert.match(src, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
    assert.match(src, /parsed\.username \|\| parsed\.password/);
});

test('the popover gets an empty preload, not the Manager preload', () => {
    const index = readFileSync(join(ROOT, 'electron/src/main/index.ts'), 'utf8');
    assert.ok(index.includes('POPOVER_PRELOAD_PATH'), 'popover has its own preload path');
    assert.ok(index.includes('preloadPath: POPOVER_PRELOAD_PATH'),
        'the popover must not use the Manager preload');
    const popover = readFileSync(join(ROOT, 'electron/src/preload/popover.ts'), 'utf8');
    // The popover preload exposes nothing: no bridge call, no exposed API.
    assert.ok(!popover.includes('exposeInMainWorld'), 'popover preload exposes no API');
    assert.ok(!popover.includes('ipcRenderer'), 'popover preload touches no IPC');
    // Strip comments before checking for an exposed bridge — the file's own
    // comment explains why it is empty and would otherwise match.
    const code = popover.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    assert.ok(!code.includes('cliJawDesktop'), 'popover preload has no desktop bridge');
});
