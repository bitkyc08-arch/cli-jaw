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
    // The popover preload exposes ONLY the two tray actions its UI calls.
    const popover = readFileSync(join(ROOT, 'electron/src/preload/popover.ts'), 'utf8');
    assert.ok(popover.includes("ipcRenderer.send('tray:popup-menu')"), 'popover keeps its menu action');
    assert.ok(popover.includes("ipcRenderer.send('tray:open-dashboard')"), 'popover keeps open-dashboard');
    // And nothing else: no folder/git/terminal/browser surface.
    for (const closed of ['folder:', 'diff:', 'terminal:', 'git:', 'browser:']) {
        assert.ok(!popover.includes(`'${closed}`), `popover preload must not expose ${closed}*`);
    }
});

test('the BUILT popover preload is the minimal tray-only artifact wired by the build', () => {
    // Prove the artifact the main process actually loads, not just the source.
    const vite = readFileSync(join(ROOT, 'electron/electron.vite.config.ts'), 'utf8');
    assert.ok(vite.includes("popover: resolve(__dirname, 'src/preload/popover.ts')"),
        'the popover preload is a build entry');
    const built = readFileSync(join(ROOT, 'electron/out/preload/popover.js'), 'utf8');
    assert.ok(built.includes('tray:popup-menu'), 'built preload keeps the menu action');
    assert.ok(built.includes('tray:open-dashboard'), 'built preload keeps open-dashboard');
    for (const closed of ['folder:listDir', 'diff:getRepoRoot', 'terminal:create', 'browser:register-webview']) {
        assert.ok(!built.includes(closed), `built popover preload must not expose ${closed}`);
    }
});
