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
    assert.ok(meta.efforts.includes('medium-fast'));
    assert.match(meta.effortNote || '', /model IDs/);
    assert.equal(meta.modelNote, undefined);
});

test('frontend AGY fallback keeps legacy model select enabled', () => {
    const meta = getCliMeta('agy');
    assert.ok(meta, 'agy metadata missing');
    assert.equal(meta.modelNote, undefined);
    assert.ok(meta.models.includes('gemini-3.5-flash'));
    assert.match(meta.effortNote || '', /no separate effort flag/);
});

test('frontend Kiro fallback exposes gateway effort choices', () => {
    const meta = getCliMeta('kiro-code');
    assert.ok(meta, 'kiro metadata missing');
    assert.deepEqual(meta.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.match(meta.effortNote || '', /xhigh to Kiro max/);
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
