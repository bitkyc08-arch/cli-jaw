import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelChoicesByCli, CODEX_MODEL_CHOICES } from '../../src/cli/registry.ts';
import { applyCodexModelsToChoices } from '../../src/cli/opencodex-models.ts';

test('applyCodexModelsToChoices keeps inactive ocx Codex defaults at four models', () => {
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
