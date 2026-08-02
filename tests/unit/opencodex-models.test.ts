import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildModelChoicesByCli, CLI_REGISTRY, CODEX_MODEL_CHOICES } from '../../src/cli/registry.ts';
import {
    applyCodexModelsToChoices,
    probeOpenCodexEndpointModels,
    resetOpenCodexModelCacheForTest,
    resolveCliDefaultModel,
    resolveOpenCodexCodexModelsDetailed,
} from '../../src/cli/opencodex-models.ts';

type OpenCodexStubOptions = {
    health?: unknown;
    healthDelayMs?: number;
    models?: unknown;
    modelsRaw?: string;
};

async function withOpenCodexStub<T>(options: OpenCodexStubOptions, fn: (endpoint: string) => Promise<T>): Promise<T> {
    const server = createServer((req, res) => {
        if (req.url === '/healthz' && options.health !== undefined) {
            const respond = () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(options.health));
            };
            if (options.healthDelayMs) setTimeout(respond, options.healthDelayMs);
            else respond();
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(options.modelsRaw ?? JSON.stringify(options.models ?? { data: [] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        return await fn(`http://127.0.0.1:${address.port}/v1`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
}

async function withInactiveOpenCodexEnv<T>(fn: () => Promise<T>): Promise<T> {
    const previousDir = process.env['CLI_JAW_OPENCODEX_DIR'];
    const tmp = await mkdtemp(join(tmpdir(), 'jaw-ocx-inactive-'));
    process.env['CLI_JAW_OPENCODEX_DIR'] = tmp;
    resetOpenCodexModelCacheForTest();
    try {
        return await fn();
    } finally {
        resetOpenCodexModelCacheForTest();
        if (previousDir === undefined) delete process.env['CLI_JAW_OPENCODEX_DIR'];
        else process.env['CLI_JAW_OPENCODEX_DIR'] = previousDir;
    }
}

test('opencodex runtime port path resolves CLI_JAW_OPENCODEX_DIR lazily', async () => {
    const src = await readFile(new URL('../../src/cli/opencodex-models.ts', import.meta.url), 'utf8');
    assert.match(src, /function openCodexRuntimePortPath\(\): string/);
    assert.match(src, /readFile\(openCodexRuntimePortPath\(\), 'utf8'\)/);
    assert.doesNotMatch(src, /const OPENCODEX_RUNTIME_PORT_PATH/);
});

test('applyCodexModelsToChoices keeps inactive ocx Codex defaults at seven models', () => {
    const choices = applyCodexModelsToChoices(buildModelChoicesByCli(), CODEX_MODEL_CHOICES);
    assert.deepEqual(choices.codex, CODEX_MODEL_CHOICES);
    assert.deepEqual(choices['codex-app'], CODEX_MODEL_CHOICES);
    assert.deepEqual(
        choices['ai-e'].filter((model) => CODEX_MODEL_CHOICES.includes(model)),
        CODEX_MODEL_CHOICES,
    );
});

test('applyCodexModelsToChoices expands Codex choices with active ocx routed models', () => {
    const activeModels = [
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
        'kiro/claude-opus-4.6',
        'kiro/claude-opus-4.8',
        'kiro/claude-sonnet-4.6',
        'opencode-go/glm-5.2',
        'opencode-go/kimi-k2.7-code',
    ];
    const choices = applyCodexModelsToChoices(buildModelChoicesByCli(), activeModels);
    assert.deepEqual(choices.codex, activeModels);
    assert.deepEqual(choices['codex-app'], activeModels);
    for (const model of activeModels) {
        assert.ok(choices['ai-e'].includes(model), `ai-e choices should include ${model}`);
    }
});

test('resolveCliDefaultModel keeps inactive ocx Codex default at first fallback model', async () => {
    await withInactiveOpenCodexEnv(async () => {
        assert.equal(await resolveCliDefaultModel('codex'), CODEX_MODEL_CHOICES[0]);
        assert.equal(await resolveCliDefaultModel('claude'), CLI_REGISTRY.claude.defaultModel);
        assert.deepEqual(await resolveOpenCodexCodexModelsDetailed(), {
            models: CODEX_MODEL_CHOICES,
            source: 'static',
        });
    });
});

test('probeOpenCodexEndpointModels rejects healthz without opencodex identity', async () => {
    await withOpenCodexStub({
        health: { status: 'ok' },
        models: { data: [{ id: 'must-not-be-trusted' }] },
    }, async (endpoint) => {
        assert.equal(await probeOpenCodexEndpointModels(endpoint), null);
    });
});

test('probeOpenCodexEndpointModels rejects a missing healthz route', async () => {
    await withOpenCodexStub({ models: { data: [{ id: 'must-not-be-trusted' }] } }, async (endpoint) => {
        assert.equal(await probeOpenCodexEndpointModels(endpoint), null);
    });
});

test('probeOpenCodexEndpointModels returns null on timeout', async () => {
    await withOpenCodexStub({
        health: { status: 'ok', service: 'opencodex' },
        healthDelayMs: 80,
        models: { data: [{ id: 'too-late' }] },
    }, async (endpoint) => {
        assert.equal(await probeOpenCodexEndpointModels(endpoint, 20), null);
    });
});

test('probeOpenCodexEndpointModels returns null for non-JSON models', async () => {
    await withOpenCodexStub({
        health: { status: 'ok', service: 'opencodex' },
        modelsRaw: 'not-json',
    }, async (endpoint) => {
        assert.equal(await probeOpenCodexEndpointModels(endpoint), null);
    });
});

test('probeOpenCodexEndpointModels returns null for empty model data', async () => {
    await withOpenCodexStub({
        health: { status: 'ok', service: 'opencodex' },
        models: { data: [] },
    }, async (endpoint) => {
        assert.equal(await probeOpenCodexEndpointModels(endpoint), null);
    });
});

test('probeOpenCodexEndpointModels returns ids for a verified opencodex endpoint', async () => {
    await withOpenCodexStub({
        health: { status: 'ok', service: 'opencodex' },
        models: { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] },
    }, async (endpoint) => {
        assert.deepEqual(await probeOpenCodexEndpointModels(endpoint), ['gpt-5.5', 'gpt-5.4']);
    });
});

test('resolveCliDefaultModel uses the first active ocx routed model for Codex', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'jaw-ocx-models-'));
    const activeModels = ['kiro/claude-opus-4.8', 'gpt-5.5'];
    const server = createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'opencodex' }));
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: activeModels.map((id) => ({ id })) }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(join(tmp, 'runtime-port.json'), JSON.stringify({ port: address.port }));
    const previousDir = process.env['CLI_JAW_OPENCODEX_DIR'];
    process.env['CLI_JAW_OPENCODEX_DIR'] = tmp;
    try {
        const moduleUrl = pathToFileURL(join(process.cwd(), 'src/cli/opencodex-models.ts'));
        moduleUrl.searchParams.set('case', `active-${Date.now()}`);
        const mod = await import(moduleUrl.href) as typeof import('../../src/cli/opencodex-models.ts');
        assert.deepEqual(await mod.resolveOpenCodexCodexModelsDetailed(), {
            models: activeModels,
            source: 'opencodex',
        });
        assert.deepEqual(await mod.resolveOpenCodexCodexModelsDetailed(), {
            models: activeModels,
            source: 'opencodex',
        });
        assert.equal(await mod.resolveCliDefaultModel('codex'), activeModels[0]);
        assert.equal(await mod.resolveCliDefaultModel('codex-app'), activeModels[0]);
        assert.equal(await mod.resolveCliDefaultModel('claude'), CLI_REGISTRY.claude.defaultModel);
    } finally {
        if (previousDir === undefined) delete process.env['CLI_JAW_OPENCODEX_DIR'];
        else process.env['CLI_JAW_OPENCODEX_DIR'] = previousDir;
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
});
