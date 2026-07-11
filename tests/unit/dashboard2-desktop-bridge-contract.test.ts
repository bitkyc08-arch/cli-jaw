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

const providerPath = 'public/dashboard2/src/providers/desktop-bridge-provider.tsx';
const contractPath = 'public/dashboard2/src/providers/desktop-bridge-contract.ts';

test('desktop bridge keeps the renderer token behind an auth-header accessor', () => {
    const provider = read(providerPath);

    assert.ok(provider.includes('getAuthHeader()'), 'context must expose an auth-header accessor');
    assert.ok(provider.includes('getAuthHeader: () =>'), 'provider value must implement the accessor');
    assert.match(
        provider,
        /identity:\s*\{\s*name:\s*identified\.name,\s*electron:\s*identified\.electron,\s*header:\s*identified\.header,?\s*\}/s,
        'public identity must be reconstructed without the token',
    );
    assert.doesNotMatch(
        provider,
        /identity:\s*\{[^}]*token\s*:/s,
        'context identity must not contain token',
    );
});

test('desktop environment records the four ordered detection outcomes', () => {
    const provider = read(providerPath);
    const detections = ['bridge-identity', 'document-marker', 'user-agent', 'web'];
    const positions = detections.map((detection) => provider.indexOf(`detection: '${detection}'`));

    assert.ok(positions.every((position) => position >= 0), 'all detection outcomes must exist');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'detection outcomes must remain ordered');
});

test('desktop capabilities distinguish native presence from v1 wiring', () => {
    const provider = read(providerPath);

    assert.ok(provider.includes('nativeAvailable: boolean'));
    assert.ok(provider.includes('nativeWired: boolean'));
    assert.match(provider, /terminal:\s*\{[^\n]*nativeAvailable:\s*terminalAvailable/s);
    assert.match(provider, /nativeWired:\s*false/);
});

test('provider omits diagnostics and direct webview control from its surface', () => {
    const provider = read(providerPath);

    assert.doesNotMatch(provider, /\bgetMetrics\b/, 'metrics diagnostics must not enter the provider surface');
    assert.doesNotMatch(provider, /\bcontrolWebview\b/, 'direct webview control must not enter the provider surface');
});

test('raw desktop contract is independent from the frozen manager renderer', () => {
    const contract = read(contractPath);

    assert.doesNotMatch(contract, /public\/manager\/src|from\s+['"][^'"]*manager\/src/);
    assert.match(contract, /token:\s*string/);
    assert.match(contract, /reloadWindow\?:\s*\(\)\s*=>\s*Promise<void>/);
    assert.match(contract, /hardReloadWindow\?:\s*\(\)\s*=>\s*Promise<void>/);
    assert.match(contract, /stale\?:\s*true/);
});
