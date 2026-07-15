import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const read = (path: string): string => readSource(join(projectRoot, path), 'utf8');

test('Electron BrowserPanel registers a stable panel-scoped webview target', () => {
    const source = read('public/dashboard2/src/shell/panels/BrowserPanel.tsx');
    assert.match(source, /`browser:\$\{panelId\}:1`/);
    assert.match(source, /addEventListener\('dom-ready',\s*onDomReady\)/);
    assert.match(source, /getWebContentsId\?\.\(\)/);
    assert.match(source, /registerWebview\(\{\s*tabId,\s*webContentsId\s*\}\)/);
    assert.match(source, /unregisterWebview\(\{\s*tabId,\s*webContentsId\s*\}\)/);
    assert.match(source, /const setWebviewRef = useCallback/);
});

test('all Electron toolbar navigation uses controlWebview and bridge state', () => {
    const source = read('public/dashboard2/src/shell/panels/BrowserPanel.tsx');
    for (const kind of ['navigate', 'reload', 'goBack', 'goForward', 'stop']) {
        assert.ok(source.includes(`kind: '${kind}'`), `missing ${kind} command`);
    }
    assert.match(source, /native\.controlWebview\(command\)/);
    assert.match(source, /native\.onWebviewState\(applyBridgeState\)/);
    assert.match(source, /render-process-gone/);
    assert.match(source, /did-fail-load/);
});

test('open-url events are filtered by source ownership and new panels use openPanel', () => {
    const source = read('public/dashboard2/src/shell/panels/BrowserPanel.tsx');
    assert.match(source, /openUrlOwners\.get\(payload\.sourceWebContentsId\) !== panelId/);
    assert.match(source, /payload\.disposition === 'current-tab'/);
    assert.match(source, /openPanel\(\{\s*type: 'browser'/s);
});

test('web stays iframe-only and broken Electron wiring does not silently downgrade', () => {
    const source = read('public/dashboard2/src/shell/panels/BrowserPanel.tsx');
    assert.match(source, /!bridge\.environment\.isElectron[^\n]*WebIframeBrowser/);
    assert.match(source, /Desktop browser unavailable/);
    assert.equal((source.match(/<iframe/g) ?? []).length, 1);
});

test('SidePane passes the stable panel instance id into BrowserPanel', () => {
    const source = read('public/dashboard2/src/shell/SidePane.tsx');
    assert.match(source, /<BrowserPanel panelId=\{panel\.id\}\s*\/>/);
});
