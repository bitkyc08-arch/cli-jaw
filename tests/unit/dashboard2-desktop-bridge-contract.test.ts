import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

const providerPath = 'public/dashboard2/src/providers/desktop-bridge-provider.tsx';
const contractPath = 'public/dashboard2/src/providers/desktop-bridge-contract.ts';

test('desktop bridge exposes detection metadata without renderer auth material', () => {
    const provider = read(providerPath);
    const contract = read(contractPath);
    const preload = read('electron/src/preload/index.ts');

    assert.equal(provider.includes('getAuthHeader'), false, 'context must not expose an auth-header accessor');
    assert.match(
        provider,
        /identity:\s*\{\s*name:\s*identified\.name,\s*electron:\s*identified\.electron,?\s*\}/s,
        'public identity must contain detection metadata only',
    );
    assert.doesNotMatch(provider, /\btoken\b|identified\.header/, 'provider must not read renderer auth material');
    assert.doesNotMatch(contract, /\btoken\s*:|\bheader\s*:/, 'raw dashboard2 contract must not declare renderer auth material');
    assert.doesNotMatch(preload, /CLI_JAW_ELECTRON_RENDERER_TOKEN|installDesktopFetchHeader|window\.fetch/, 'preload must not receive or inject renderer auth material');
});

test('desktop environment records the four ordered detection outcomes', () => {
    const provider = read(providerPath);
    const detections = ['bridge-identity', 'document-marker', 'user-agent', 'web'];
    const positions = detections.map((detection) => provider.indexOf(`detection: '${detection}'`));

    assert.ok(positions.every((position) => position >= 0), 'all detection outcomes must exist');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'detection outcomes must remain ordered');
});

test('desktop capabilities inject native adapters with a single availability judgment', () => {
    const provider = read(providerPath);

    assert.ok(provider.includes('nativeAvailable: boolean'));
    assert.ok(provider.includes('nativeWired: boolean'));
    assert.match(provider, /terminal:\s*wired<TerminalBridgeApi>\(terminalAvailable,\s*raw\?\.terminal\)/);
    assert.match(provider, /folder:\s*wired<FolderBridgeApi>\(folderAvailable,\s*raw\?\.folder\)/);
    assert.match(provider, /dragDrop:\s*wired<DragDropBridgeApi>\(dragDropAvailable,\s*raw\?\.dragDrop\)/);
    assert.match(provider, /diff:\s*wired<DiffBridgeApi>\(diffAvailable,\s*raw\?\.diff,\s*'stub'\)/);
    assert.match(provider, /git:\s*wired<GitBridgeApi>\(gitAvailable,\s*raw\?\.git,\s*'stub'\)/);
    assert.match(provider, /shortcuts:\s*wired<ShortcutsBridgeApi>\(shortcutsAvailable,\s*raw\?\.shortcuts\)/);
    assert.match(provider, /tray:\s*wired<TrayBridgeApi>\(trayAvailable,\s*raw\?\.trayReminders\)/);
    assert.match(
        provider,
        /nativeWired:\s*native !== null/,
        'wired() must derive nativeWired from the same availability judgment that gates native injection',
    );
    assert.match(
        provider,
        /nativeWired:\s*browserNative !== null/,
        'browser surface must wire through the minimal ExposedBrowserApi adapter',
    );
});

test('provider omits diagnostics while allowing the audited navigation-only webview control', () => {
    const provider = read(providerPath);

    assert.doesNotMatch(provider, /\bgetMetrics\b/, 'metrics diagnostics must not enter the provider surface');
    // 089.06 §7-1: controlWebview is intentionally exposed for navigate/reload/back/forward/stop;
    // broader diagnostics such as getMetrics remain outside the dashboard2 provider.
    assert.match(provider, /\| 'controlWebview'/, 'navigation control must be part of ExposedBrowserApi');
    assert.match(provider, /controlWebview:\s*rawBrowser\.controlWebview\.bind\(rawBrowser\)/);
});

test('preload intentionally omits the retired metrics pull contract', () => {
    const preload = read('electron/src/preload/index.ts');

    // 089.11 §7-4 is an intentional contract removal: no consumer may revive preload polling or getMetrics.
    assert.doesNotMatch(preload, /\bgetMetrics\b|setupMetricsBridge|\.\/metrics\.js/);
    assert.equal(existsSync(join(projectRoot, 'electron/src/preload/metrics.ts')), false);
});

test('raw desktop contract is independent from the frozen manager renderer', () => {
    const contract = read(contractPath);

    assert.doesNotMatch(contract, /public\/manager\/src|from\s+['"][^'"]*manager\/src/);
    assert.match(contract, /name:\s*'cli-jaw-desktop'/);
    assert.match(contract, /electron:\s*true/);
    assert.doesNotMatch(contract, /token:\s*string|header:\s*'X-CLI-Jaw-Electron'/);
    assert.match(contract, /reloadWindow\?:\s*\(\)\s*=>\s*Promise<void>/);
    assert.match(contract, /hardReloadWindow\?:\s*\(\)\s*=>\s*Promise<void>/);
    assert.match(contract, /stale\?:\s*true/);
});
