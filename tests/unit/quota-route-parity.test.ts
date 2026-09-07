import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const readers: Record<string, () => Promise<unknown>> = {};
const read = (name: string) => () => readers[name]!();
let hasCredentials = true;
mock.module('../../src/routes/quota.ts', { namedExports: {
    readClaudeCreds: () => hasCredentials ? { token: 'fixture' } : null,
    readCodexTokens: () => hasCredentials ? { access_token: 'fixture' } : null,
    fetchClaudeUsage: read('claude'), fetchCodexUsage: read('codex'), fetchGrokStatus: read('grok'),
} });
mock.module('../../src/routes/quota-cursor-dashboard.ts', { namedExports: { fetchCursorUsage: read('cursor') } });
mock.module('../../src/routes/quota-agy-reverse.ts', { namedExports: { fetchAgyUsage: read('agy') } });
mock.module('../../src/routes/quota-kiro-reverse.ts', { namedExports: { fetchKiroUsage: read('kiro') } });
mock.module('../../src/routes/quota-opencode-go-api.ts', { namedExports: { fetchOpenCodeUsage: read('opencode') } });
mock.module('../../lib/quota-copilot.ts', { namedExports: {
    fetchCopilotQuota: read('copilot'), refreshCopilotFromKeychain: async () => ({}), hasCopilotAuthSync: () => false,
} });
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const { CLI_KEYS } = await import('../../src/cli/registry.ts');
const exec = promisify(execFile);
function resetReaders() {
    hasCredentials = true;
    for (const [i, name] of ['claude', 'codex', 'grok', 'cursor', 'agy', 'kiro', 'opencode', 'copilot'].entries()) {
        readers[name] = async () => ({ authenticated: true, quotaCapable: true,
            windows: [{ label: name, percent: i, resetsAt: null }] });
    }
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test('quota HTTP route preserves contracts, isolates failure, and starts Grok concurrently', async t => {
    resetReaders();
    const app = express();
    registerSettingsRoutes(app, (_req, _res, next) => next(), async () => ({}), process.cwd());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/quota`;
    const evidence = process.env['QUOTA_QA_OUTPUT'];
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const capture = async (name: string) => {
        const { stdout } = await exec('curl', ['--silent', '--show-error', '--max-time', '10', '-i', url]);
        assert.match(stdout, /^HTTP\/1\.1 200 /);
        if (evidence) fs.writeFileSync(path.join(evidence, `${name}.http`), stdout);
        return JSON.parse(stdout.split('\r\n\r\n').slice(1).join('\r\n\r\n')) as Record<string, { windows?: unknown[]; error?: boolean; authenticated?: boolean; delegatedProvider?: string }>;
    };
    try {
        await t.test('success keyset, zero window, and wrappers retain provider mapping', async () => {
            const result = await capture('success');
            assert.deepEqual(Object.keys(result), CLI_KEYS);
            assert.deepEqual(result['claude-e']?.windows, result['claude']?.windows);
            assert.deepEqual(result['codex-app']?.windows, result['codex']?.windows);
            assert.equal(result['codex-app']?.delegatedProvider, 'codex');
            const provider = result['ai-e']?.delegatedProvider;
            assert.ok(provider);
            assert.deepEqual(result['ai-e']?.windows, result[provider]?.windows);
            assert.deepEqual(result['claude']?.windows, [{ label: 'claude', percent: 0, resetsAt: null }]);
        });
        await t.test('one rejected provider does not hide successful peers or change keyset', async () => {
            readers['codex'] = async () => { throw new Error('fixture-private-upstream-detail'); };
            const result = await capture('partial-failure');
            assert.deepEqual(Object.keys(result), CLI_KEYS);
            assert.equal(result['codex']?.error, true);
            assert.equal(result['codex-app']?.error, true);
            assert.equal(result['claude']?.error, undefined);
            readers['claude'] = async () => null;
            readers['opencode'] = async () => null;
            const unknown = await capture('configured-but-unavailable');
            assert.equal(unknown['claude']?.error, true);
            assert.deepEqual(unknown['opencode']?.windows, []);
            assert.equal(unknown['grok']?.authenticated, true);
            assert.ok(!JSON.stringify(result).includes('fixture-private-upstream-detail'));
            resetReaders();
        });
        await t.test('absent credentials remain unauthenticated and repeat requests recover', async () => {
            hasCredentials = false;
            readers['claude'] = readers['codex'] = async () => null;
            const result = await capture('absent');
            assert.equal(result['claude']?.authenticated, false);
            assert.equal(result['codex']?.authenticated, false);
            resetReaders();
            const recovered = await capture('recovered');
            assert.equal(recovered['codex']?.authenticated, true);
        });
        await t.test('Grok starts while Claude is still pending, and concurrent requests settle', async () => {
            const claude = deferred<unknown>();
            const grok = deferred<unknown>();
            const claudeStarted = deferred<void>();
            const grokStarted = deferred<void>();
            readers['claude'] = () => { claudeStarted.resolve(); return claude.promise; };
            readers['grok'] = () => { grokStarted.resolve(); return grok.promise; };
            const pending = fetch(url);
            await claudeStarted.promise;
            let started = false;
            void grokStarted.promise.then(() => { started = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            const startedBeforeRelease = started;
            claude.resolve({ windows: [{ label: 'held-claude', percent: 20 }] });
            grok.resolve({ windows: [{ label: 'held-grok', percent: 30 }] });
            const result = await (await pending).json() as Record<string, { windows: unknown[] }>;
            assert.equal(startedBeforeRelease, true, 'Grok must start before the unresolved Claude read finishes');
            assert.deepEqual(result['grok']?.windows, [{ label: 'held-grok', percent: 30 }]);
            resetReaders();
            await Promise.all([capture('concurrent-a'), capture('concurrent-b')]);
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(server.listening, false);
        if (evidence) fs.writeFileSync(path.join(evidence, 'teardown.txt'), `Listener ${address.port} closed; server.listening=false. Provider boundaries were synthetic; no external provider calls.\n`);
    }
});
