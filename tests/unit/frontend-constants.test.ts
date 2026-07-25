import test from 'node:test';
import assert from 'node:assert/strict';
import { getCliMeta } from '../../public/js/constants.js';
import { CLI_REGISTRY } from '../../src/cli/registry.ts';

const DEFAULT_CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

test('frontend copilot meta exposes selectable efforts', () => {
    const meta = getCliMeta('copilot');
    assert.ok(meta, 'copilot metadata missing');
    assert.deepEqual(meta.efforts, ['low', 'medium', 'high']);
});

test('frontend copilot meta preserves effortNote hint', () => {
    const meta = getCliMeta('copilot');
    assert.equal(meta.effortNote, '-> ~/.copilot/config.json');
});

test('frontend cursor meta exposes model-ID effort choices', () => {
    const meta = getCliMeta('cursor');
    assert.ok(meta, 'cursor metadata missing');
    assert.ok(meta.models.includes('gpt-5.5'));
    assert.ok(meta.models.includes('gpt-5.1-codex-mini'));
    assert.ok(meta.models.includes('claude-opus-5'), 'web cursor fallback is missing claude-opus-5');
    assert.ok(meta.efforts.includes('medium-fast'));
    assert.match(meta.effortNote || '', /model IDs/);
    assert.equal(meta.modelNote, undefined);
});

test('frontend AGY fallback keeps legacy model select enabled', () => {
    const meta = getCliMeta('agy');
    assert.ok(meta, 'agy metadata missing');
    assert.equal(meta.modelNote, undefined);
    assert.ok(meta.models.length > 0);
    assert.match(meta.effortNote || '', /no separate effort flag/);
});

// AGY takes the picker string as `agy --model <value>` verbatim and cli-jaw
// never sends --effort for AGY (src/agent/args.ts case 'agy'). AGY 1.1.4
// rejects a bare tier-less slug in that shape ("--model gemini-3.5-flash
// requires --effort"), so the offline fallback has to offer at least one
// label-form entry that works on its own.
test('frontend AGY fallback offers a label-form model that AGY accepts without --effort', () => {
    const meta = getCliMeta('agy');
    assert.ok(meta, 'agy metadata missing');
    const labelForm = meta.models.filter((model) => /\((Low|Medium|High)\)$/.test(model));
    assert.ok(labelForm.length > 0, `AGY fallback has no label-form model: ${meta.models.join(', ')}`);
    assert.ok(meta.models.includes('Gemini 3.6 Flash (Medium)'));
    // Every offered value must be usable as-is. A tier-less slug like
    // `gemini-3.5-flash` fails with "requires --effort" and must not be listed;
    // persisted values still render via the custom-option path in settings-core.
    for (const model of meta.models) {
        assert.match(
            model,
            /\((Low|Medium|High)\)$/,
            `AGY fallback offers ${model}, which AGY rejects without --effort`,
        );
    }
});

test('frontend Kiro fallback exposes gateway effort choices', () => {
    const meta = getCliMeta('kiro-code');
    assert.ok(meta, 'kiro metadata missing');
    assert.deepEqual(meta.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.match(meta.effortNote || '', /xhigh to Kiro max/);
});

// Web fallback parity for Kiro: these arrays are what the picker shows when
// GET /api/cli-registry fails, so they must not drift behind the backend.
test('frontend Kiro fallbacks stay in parity with the backend Kiro catalogs', () => {
    const required = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-opus-5'];
    const kiro = getCliMeta('kiro-code');
    const aiE = getCliMeta('ai-e');
    assert.ok(kiro, 'kiro metadata missing');
    assert.ok(aiE, 'ai-e metadata missing');
    for (const model of required) {
        assert.ok(kiro.models.includes(model), `web kiro-code fallback is missing ${model}`);
        assert.ok(aiE.modelsByProvider?.kiro?.includes(model), `web ai-e kiro fallback is missing ${model}`);
    }
    for (const model of kiro.models) {
        assert.ok(
            CLI_REGISTRY['kiro-code'].models.includes(model),
            `web kiro-code fallback lists ${model} but the backend registry does not`,
        );
    }
});

test('frontend Codex fallback shows only inactive ocx default models', () => {
    const codex = getCliMeta('codex');
    const codexApp = getCliMeta('codex-app');
    const aiE = getCliMeta('ai-e');
    assert.ok(codex, 'codex metadata missing');
    assert.ok(codexApp, 'codex-app metadata missing');
    assert.ok(aiE, 'ai-e metadata missing');
    assert.deepEqual(codex.models, DEFAULT_CODEX_MODELS);
    assert.deepEqual(codexApp.models, DEFAULT_CODEX_MODELS);
    assert.deepEqual(aiE.modelsByProvider?.codex, DEFAULT_CODEX_MODELS);
});

// The web fallback is what the picker renders when GET /api/cli-registry fails
// (see loadCliRegistry in public/js/constants.ts), so a model that exists only
// in the backend registry silently disappears offline. 260725: the AI-E
// provider=claude fallback drifted exactly this way when claude-opus-5 landed,
// and the Codex-only assertion above did not catch it.
test('frontend AI-E claude fallback stays in parity with the backend registry', () => {
    const aiE = getCliMeta('ai-e');
    assert.ok(aiE, 'ai-e metadata missing');
    const backend = CLI_REGISTRY['ai-e'].modelsByProvider.claude;
    const fallback = aiE.modelsByProvider?.claude ?? [];
    for (const model of fallback) {
        assert.ok(
            backend.includes(model),
            `web fallback lists ${model} for provider=claude but the backend registry does not`,
        );
    }
    // Pinned full IDs the fallback must expose; aliases resolve server-side.
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5']) {
        assert.ok(fallback.includes(model), `web fallback is missing ${model} for provider=claude`);
    }
});
