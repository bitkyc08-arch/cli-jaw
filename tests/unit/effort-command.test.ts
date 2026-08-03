import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { resolve } from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname;

// `/effort` used to hardcode ['off','low','medium','high','max']: `xhigh` was
// missing entirely and `ultra` was REJECTED, so a live opencodex model that
// advertises `ultra` could not be selected at all. The accepted set is now
// resolved per CLI and, for Codex, per MODEL.
let stubbed = false;
function stubOpenCodex() {
    if (stubbed) return;
    stubbed = true;
    mock.module(resolve(__dirname, '../../src/cli/opencodex-models.js'), {
        namedExports: {
            resolveOpenCodexCodexModelsDetailed: async () => ({
                models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'anthropic/claude-fable-5'],
                entries: [
                    { id: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
                    { id: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
                    { id: 'anthropic/claude-fable-5', efforts: [] },
                ],
                source: 'opencodex',
            }),
            // Keep the module's other exports alive: mock.module REPLACES the
            // whole module, and pi-runtime imports probeOpenCodexEndpointModels.
            probeOpenCodexEndpointModels: async () => null,
            resolveOpenCodexCodexModels: async () => ['gpt-5.6-sol', 'gpt-5.6-luna'],
            applyCodexModelsToChoices: (choices: Record<string, string[]>) => choices,
            resolveCliDefaultModel: async () => 'gpt-5.6-sol',
            parseModelEntries: () => [],
            resetOpenCodexModelCacheForTest: () => {},
        },
    });
}

async function loadCommands() {
    const url = new URL('../../src/cli/commands.ts', import.meta.url);
    url.searchParams.set('case', `effort-${Date.now()}-${Math.random()}`);
    return await import(url.href) as typeof import('../../src/cli/commands.ts');
}

function makeCtx(cli: string, model: string, effort: string) {
    const saved: Record<string, unknown>[] = [];
    return {
        saved,
        ctx: {
            interface: 'cli',
            locale: 'en',
            getSettings: async () => ({
                cli,
                perCli: { [cli]: { model, effort } },
                activeOverrides: { [cli]: { model, effort } },
            }),
            updateSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return { ok: true }; },
        },
    };
}

async function runEffort(mod: Awaited<ReturnType<typeof loadCommands>>, ctx: unknown, args: string) {
    const parsed = mod.parseCommand(`/effort${args ? ` ${args}` : ''}`);
    return await mod.executeCommand(parsed, ctx as never);
}

test('resolveEffortLevelsForCli narrows Codex efforts per model', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    assert.deepEqual(
        await mod.resolveEffortLevelsForCli('codex', 'gpt-5.6-sol'),
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    );
    // luna stops at max: `ultra` must not be offered.
    assert.deepEqual(
        await mod.resolveEffortLevelsForCli('codex', 'gpt-5.6-luna'),
        ['low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.deepEqual(await mod.resolveEffortLevelsForCli('codex', 'anthropic/claude-fable-5'), []);
});

test('resolveEffortLevelsForCli falls back to the static registry for non-Codex runtimes', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { CLI_REGISTRY } = await import('../../src/cli/registry.ts');
    assert.deepEqual(
        await mod.resolveEffortLevelsForCli('claude', 'claude-fable-5'),
        [...CLI_REGISTRY.claude.efforts],
    );
});

test('/effort accepts ultra on a model that advertises it', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { ctx, saved } = makeCtx('codex', 'gpt-5.6-sol', 'medium');
    const result = await runEffort(mod, ctx, 'ultra');
    assert.equal(result?.ok, true);
    // Written where the runtime reads it (spawn.ts: activeOverrides -> perCli),
    // not to a top-level `effort` key that nothing consumes.
    assert.equal((saved[0]?.['activeOverrides'] as Record<string, { effort: string }>)['codex'].effort, 'ultra');
    assert.equal((saved[0]?.['perCli'] as Record<string, { effort: string }>)['codex'].effort, 'ultra');
});

test('/effort accepts xhigh, which the old hardcoded list omitted entirely', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { ctx, saved } = makeCtx('codex', 'gpt-5.6-sol', 'medium');
    const result = await runEffort(mod, ctx, 'xhigh');
    assert.equal(result?.ok, true);
    assert.equal((saved[0]?.['activeOverrides'] as Record<string, { effort: string }>)['codex'].effort, 'xhigh');
});

test('/effort rejects ultra on a model that stops at max', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { ctx, saved } = makeCtx('codex', 'gpt-5.6-luna', 'medium');
    const result = await runEffort(mod, ctx, 'ultra');
    assert.match(String(result?.text), /Unknown level "ultra"/);
    assert.equal(saved.length, 0, 'a rejected level must not be persisted');
});

test('/effort reports that an effort-less routed model takes no effort', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { ctx, saved } = makeCtx('codex', 'anthropic/claude-fable-5', '');
    const result = await runEffort(mod, ctx, '');
    assert.match(String(result?.text), /does not accept a reasoning effort/);
    assert.equal(saved.length, 0);
});

test('/effort off clears the override instead of sending a literal "off"', async () => {
    stubOpenCodex();
    const mod = await loadCommands();
    const { ctx, saved } = makeCtx('codex', 'gpt-5.6-sol', 'ultra');
    const result = await runEffort(mod, ctx, 'off');
    assert.equal(result?.ok, true);
    assert.equal((saved[0]?.['activeOverrides'] as Record<string, { effort: string }>)['codex'].effort, '');
});
