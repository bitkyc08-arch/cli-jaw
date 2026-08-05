import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    diagnoseOpenCodexExecution,
    resolveOpenCodexRuntime,
} from '../../src/cli/opencodex-runtime.ts';

async function runtimeDir(body?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ocx-runtime-'));
    if (body !== undefined) await writeFile(join(dir, 'runtime-port.json'), body);
    return dir;
}

test('runtime resolver fails closed for missing, malformed, invalid, non-2xx, and wrong fingerprints', async () => {
    const missing = await runtimeDir();
    assert.equal((await resolveOpenCodexRuntime({ directory: missing })).state, 'missing-port');

    const malformed = await runtimeDir('{');
    assert.equal((await resolveOpenCodexRuntime({ directory: malformed })).state, 'unhealthy');

    const invalid = await runtimeDir('{"port":70000}');
    assert.equal((await resolveOpenCodexRuntime({ directory: invalid })).state, 'unhealthy');

    const live = await runtimeDir('{"port":10100}');
    const non2xx = await resolveOpenCodexRuntime({
        directory: live,
        fetchImpl: async () => new Response('', { status: 503 }),
    });
    assert.equal(non2xx.state, 'unhealthy');

    const wrong = await resolveOpenCodexRuntime({
        directory: live,
        fetchImpl: async () => Response.json({ status: 'ok', service: 'other' }),
    });
    assert.equal(wrong.state, 'unhealthy');
    await Promise.all([missing, malformed, invalid, live].map((dir) => rm(dir, { recursive: true, force: true })));
});

test('runtime resolver enforces timeout and returns healthy fingerprint fields', async () => {
    const dir = await runtimeDir('{"port":10100}');
    const timeout = await resolveOpenCodexRuntime({
        directory: dir,
        timeoutMs: 10,
        fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    assert.equal(timeout.state, 'unhealthy');

    const healthy = await resolveOpenCodexRuntime({
        directory: dir,
        fetchImpl: async () => Response.json({ status: 'ok', service: 'opencodex', version: '2.10.0' }),
    });
    assert.deepEqual(healthy, {
        state: 'healthy',
        port: 10100,
        baseUrl: 'http://127.0.0.1:10100',
        version: '2.10.0',
    });
    assert.equal(diagnoseOpenCodexExecution('http://127.0.0.1:10100/v1/', healthy), 'configured-and-healthy');
    assert.equal(diagnoseOpenCodexExecution('http://127.0.0.1:9999/v1', healthy), 'config-mismatch');
    assert.equal(diagnoseOpenCodexExecution(null, healthy), 'not-configured');
    assert.equal(diagnoseOpenCodexExecution('http://127.0.0.1:10100/v1', { ...healthy, state: 'unhealthy' }), 'proxy-unavailable');
    await rm(dir, { recursive: true, force: true });
});
