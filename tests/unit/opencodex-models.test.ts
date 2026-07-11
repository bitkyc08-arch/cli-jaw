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
    resetOpenCodexModelCacheForTest,
    resolveCliDefaultModel,
} from '../../src/cli/opencodex-models.ts';

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
    });
});

test('resolveCliDefaultModel uses the first active ocx routed model for Codex', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'jaw-ocx-models-'));
    const activeModels = ['kiro/claude-opus-4.8', 'gpt-5.5'];
    const server = createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
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
        assert.equal(await mod.resolveCliDefaultModel('codex'), activeModels[0]);
        assert.equal(await mod.resolveCliDefaultModel('codex-app'), activeModels[0]);
        assert.equal(await mod.resolveCliDefaultModel('claude'), CLI_REGISTRY.claude.defaultModel);
    } finally {
        if (previousDir === undefined) delete process.env['CLI_JAW_OPENCODEX_DIR'];
        else process.env['CLI_JAW_OPENCODEX_DIR'] = previousDir;
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
});
