import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowChromeOptions } from '../../electron/src/main/lib/window/chrome-options.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('resolveWindowChromeOptions uses hiddenInset traffic lights on darwin', () => {
    const dark = resolveWindowChromeOptions('darwin', true);
    const light = resolveWindowChromeOptions('darwin', false);

    assert.equal(dark.titleBarStyle, 'hiddenInset');
    assert.deepEqual(dark.trafficLightPosition, { x: 16, y: 18 });
    assert.equal(dark.titleBarOverlay, undefined);
    assert.equal(light.titleBarStyle, 'hiddenInset');
    assert.deepEqual(light.trafficLightPosition, { x: 16, y: 18 });
    assert.equal(light.titleBarOverlay, undefined);
});

test('resolveWindowChromeOptions uses a hidden overlay on win32 and linux', () => {
    const winDark = resolveWindowChromeOptions('win32', true);
    const linuxLight = resolveWindowChromeOptions('linux', false);

    assert.equal(winDark.titleBarStyle, 'hidden');
    assert.deepEqual(winDark.titleBarOverlay, {
        height: 40,
        color: '#01000000',
        symbolColor: '#f8fafc',
    });
    assert.equal(linuxLight.titleBarStyle, 'hidden');
    assert.deepEqual(linuxLight.titleBarOverlay, {
        height: 40,
        color: '#01000000',
        symbolColor: '#1f2937',
    });
});

test('Electron main window chrome, View menu, and zoom stay on the manager webContents', () => {
    const main = read('electron/src/main/index.ts');
    const preload = read('electron/src/preload/index.ts');
    const rightIndex = main.indexOf("label: 'Toggle Right Sidebar'");
    const leftIndex = main.indexOf("label: 'Toggle Left Sidebar'");
    const resetIndex = main.indexOf("label: 'Reset Sidebar Width'");

    assert.ok(main.includes('resolveWindowChromeOptions('), 'createWindow must spread resolveWindowChromeOptions');
    assert.ok(main.includes("sendManagerShortcut('resetSidebarWidth')"), 'View menu must send resetSidebarWidth');
    assert.ok(main.includes('setZoomFactor'), 'View zoom must use webContents.setZoomFactor');
    assert.equal(main.includes("role: 'zoomIn'"), false, 'View zoom must not use Chromium zoomIn role');
    assert.ok(rightIndex >= 0 && leftIndex > rightIndex, 'Toggle Left Sidebar must sit after Toggle Right Sidebar');
    assert.ok(resetIndex > leftIndex, 'Reset Sidebar Width must sit after Toggle Left Sidebar');
    assert.ok(preload.includes('window:get-fullscreen'), 'preload must invoke window:get-fullscreen');
    assert.ok(preload.includes('window:fullscreen-changed'), 'preload must listen for window:fullscreen-changed');
    assert.equal(preload.includes('sendSync'), false, 'preload must not use ipcRenderer.sendSync');
});
