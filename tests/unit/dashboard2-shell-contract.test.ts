import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const dashboardRoot = join(projectRoot, 'public', 'dashboard2');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

function dashboardSources(directory = dashboardRoot): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return dashboardSources(path);
        return ['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name)) ? [path] : [];
    });
}

test('dashboard2 branches to tray mode before creating the React root', () => {
    const main = read('public/dashboard2/src/main.tsx');
    const trayBranch = main.indexOf("new URLSearchParams(window.location.search).get('tray') === '1'");
    const createRootCall = main.indexOf('createRoot(rootEl)');

    assert.ok(trayBranch >= 0, 'main must read the tray query before mounting providers');
    assert.ok(createRootCall >= 0, 'main must create the dashboard2 React root');
    assert.ok(trayBranch < createRootCall, 'tray mode must branch before createRoot is called');
    assert.ok(main.includes('<TrayRoot />'), 'tray mode must mount its dedicated root');
});

test('dashboard2 API provider uses manager and per-instance proxy endpoints', () => {
    const provider = read('public/dashboard2/src/providers/api-provider.tsx');

    assert.ok(provider.includes("'/api/dashboard/instances'"), 'provider must fetch manager instances');
    assert.ok(provider.includes('`/i/${port}/api/chat-sessions`'), 'session fetch must route through the /i/ proxy');
    assert.ok(provider.includes('/api/chat-sessions'), 'provider must call the instance chat sessions endpoint');
});

test('dashboard2 source tree does not import zustand', () => {
    const offenders = dashboardSources().filter((path) => {
        const source = readFileSync(path, 'utf8');
        return /(?:from\s*|import\s*\()['"]zustand(?:\/[^'"]*)?['"]/.test(source);
    });

    assert.deepEqual(offenders, [], 'dashboard2 must keep UI scope in React state');
});

test('dashboard2 API provider imports canonical manager types as type-only', () => {
    const provider = read('public/dashboard2/src/providers/api-provider.tsx');

    assert.match(
        provider,
        /import\s+type\s+\{\s*DashboardInstance\s*\}\s+from\s+['"][^'"]*src\/manager\/types\.ts['"]/,
        'DashboardInstance must use a type-only canonical import',
    );
    assert.doesNotMatch(
        provider,
        /import\s+(?!type\b)[^;]*from\s+['"][^'"]*src\/manager\/types(?:\.ts)?['"]/,
        'provider must not runtime-import manager types',
    );
});

test('dashboard2 scope documents the port boundary for SSE payloads', () => {
    const scope = read('public/dashboard2/src/state/scope.tsx');

    assert.ok(
        scope.includes('// port is UI-context identity only — it is NOT a field of SSE turn payloads (031.4)'),
        'scope must preserve the port UI-context boundary comment',
    );
});
