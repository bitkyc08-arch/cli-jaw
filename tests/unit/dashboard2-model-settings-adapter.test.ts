import assert from 'node:assert/strict';
import test from 'node:test';
import {
    adaptModelSettings,
    buildModelSettingsPatch,
    revalidateModelSelection,
    type ModelSelection,
} from '../../public/dashboard2/src/models/model-settings-adapter.ts';

const SECRET = 'SECRET_CANARY_MODEL_ADAPTER_b92d';

const registry = {
    'ai-e': {
        defaultProvider: 'claude',
        defaultModel: 'sonnet',
        defaultEffort: 'medium',
        providers: ['claude', 'codex', 'copilot', 'grok'],
        models: ['sonnet', 'gpt-5.5', 'gpt-5-mini', 'grok-build'],
        efforts: ['low', 'medium', 'high', 'max'],
        modelsByProvider: {
            claude: ['sonnet'], codex: ['gpt-5.5'], copilot: ['gpt-5-mini'], grok: ['grok-build'],
        },
        effortsByProvider: {
            claude: ['low', 'medium', 'high', 'max'],
            codex: ['low', 'medium', 'high', 'max', 'ultra'],
            copilot: ['low', 'medium', 'high'],
            grok: [],
        },
        registryToken: SECRET,
    },
    pi: {
        defaultProvider: 'progrok',
        defaultModel: 'grok-4.5',
        defaultEffort: 'medium',
        models: ['grok-4.5', 'grok-4.3'],
        efforts: ['low', 'medium', 'high'],
        apiKey: SECRET,
    },
    managerTokens: { token: SECRET },
};

test('adapter applies model precedence and preserves an explicit empty active effort', () => {
    const adapted = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'codex', model: 'gpt-5.5', effort: 'high' } },
        activeOverrides: { 'ai-e': { provider: 'claude', model: 'gpt-5.6-sol', effort: '' } },
    }, registry);

    assert.deepEqual(adapted.selection, {
        cli: 'ai-e', provider: 'codex', model: 'gpt-5.6-sol', effort: '',
    });
    assert.deepEqual(adapted.defaultSelection, {
        cli: 'ai-e', provider: 'codex', model: 'gpt-5.5', effort: 'high',
    });
    assert.equal(adapted.catalog.modelOptions.find(item => item.value === 'gpt-5.6-sol')?.synthetic, true);
});

test('AI-E provider falls back through legacy override, model inference, then default', () => {
    const legacy = adaptModelSettings({
        cli: 'ai-e', perCli: { 'ai-e': { model: 'sonnet' } },
        activeOverrides: { 'ai-e': { provider: 'copilot' } },
    }, registry);
    assert.equal(legacy.selection.provider, 'copilot');

    const inferred = adaptModelSettings({
        cli: 'ai-e', perCli: { 'ai-e': { model: 'gpt-5.5' } },
    }, registry);
    assert.equal(inferred.selection.provider, 'codex');

    const fallback = adaptModelSettings({ cli: 'ai-e', perCli: { 'ai-e': {} } }, registry);
    assert.equal(fallback.selection.provider, 'claude');
});

test('active and default mutation modes emit only their allowlisted persistence keys', () => {
    const selection: ModelSelection = {
        cli: 'ai-e', provider: 'codex', model: 'gpt-5.5', effort: '',
    };
    assert.deepEqual(buildModelSettingsPatch(selection, 'active'), {
        perCli: { 'ai-e': { provider: 'codex' } },
        activeOverrides: { 'ai-e': { model: 'gpt-5.5', effort: '' } },
    });
    assert.deepEqual(buildModelSettingsPatch(selection, 'default'), {
        perCli: { 'ai-e': { provider: 'codex', model: 'gpt-5.5', effort: '' } },
    });
});

test('default mode catalogs the persistent provider when an active override uses another provider', () => {
    const adapted = adaptModelSettings({
        cli: 'codex',
        perCli: { codex: { model: 'gpt-default', effort: 'medium' } },
        activeOverrides: { codex: { provider: 'azure', model: 'gpt-active', effort: 'high' } },
    }, {
        codex: {
            providers: ['openai', 'azure'],
            modelsByProvider: { openai: ['gpt-default'], azure: ['gpt-active'] },
            effortsByProvider: { openai: ['medium'], azure: ['high'] },
        },
    }, 'default');

    assert.deepEqual(adapted.catalog.modelOptions.map(option => option.value), ['gpt-default']);
    assert.deepEqual(adapted.catalog.effortOptions.map(option => option.value), ['', 'medium']);
    assert.equal(adapted.catalog.mutationEnabled, true);
});

test('provider changes revalidate model and effort against the new provider inventory', () => {
    const adapted = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'claude', model: 'sonnet', effort: 'max' } },
    }, registry);
    assert.deepEqual(revalidateModelSelection(adapted.selection, {
        ...adapted.selection, provider: 'copilot', model: 'sonnet', effort: 'max',
    }, adapted.catalog), {
        cli: 'ai-e', provider: 'copilot', model: 'gpt-5-mini', effort: 'medium',
    });
    assert.deepEqual(revalidateModelSelection(adapted.selection, {
        ...adapted.selection, provider: 'grok', model: 'sonnet', effort: 'max',
    }, adapted.catalog), {
        cli: 'ai-e', provider: 'grok', model: 'grok-build', effort: '',
    });
});

test('AI-E provider changes atomically revalidate the opposite active/default tuple', () => {
    const adapted = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'claude', model: 'sonnet', effort: 'max' } },
        activeOverrides: { 'ai-e': { model: 'opus', effort: 'high' } },
    }, registry);
    const activeSelection = revalidateModelSelection(adapted.selection, {
        ...adapted.selection, provider: 'codex', model: 'gpt-5.5', effort: 'high',
    }, adapted.catalog);
    assert.deepEqual(buildModelSettingsPatch(activeSelection, 'active', adapted), {
        perCli: { 'ai-e': { provider: 'codex', model: 'gpt-5.5', effort: 'max' } },
        activeOverrides: { 'ai-e': { model: 'gpt-5.5', effort: 'high' } },
    });

    const defaultSelection = revalidateModelSelection(adapted.defaultSelection, {
        ...adapted.defaultSelection, provider: 'grok', model: 'grok-build', effort: '',
    }, adapted.catalog);
    assert.deepEqual(buildModelSettingsPatch(defaultSelection, 'default', adapted), {
        perCli: { 'ai-e': { provider: 'grok', model: 'grok-build', effort: '' } },
        activeOverrides: { 'ai-e': { model: 'grok-build', effort: '' } },
    });
});

test('default provider change repairs an explicit equal override but leaves absent overrides absent', () => {
    const equalOverride = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'claude', model: 'sonnet', effort: 'high' } },
        activeOverrides: { 'ai-e': { model: 'sonnet', effort: 'high' } },
    }, registry, 'default');
    assert.equal(equalOverride.activeOverrideMasksDefault, false);
    assert.equal(equalOverride.hasActiveOverride, true);
    const next = revalidateModelSelection(equalOverride.defaultSelection, {
        ...equalOverride.defaultSelection,
        provider: 'codex',
        model: 'gpt-5.5',
    }, equalOverride.catalog);
    assert.deepEqual(buildModelSettingsPatch(next, 'default', equalOverride), {
        perCli: { 'ai-e': { provider: 'codex', model: 'gpt-5.5', effort: 'high' } },
        activeOverrides: { 'ai-e': { model: 'gpt-5.5', effort: 'high' } },
    });

    const noOverride = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'claude', model: 'sonnet', effort: 'high' } },
    }, registry, 'default');
    assert.equal(noOverride.hasActiveOverride, false);
    assert.deepEqual(buildModelSettingsPatch(next, 'default', noOverride), {
        perCli: { 'ai-e': { provider: 'codex', model: 'gpt-5.5', effort: 'high' } },
    });
});

test('Pi keeps its current profile provider and does not expose provider mutation', () => {
    const adapted = adaptModelSettings({
        cli: 'pi', perCli: { pi: { provider: 'private-profile', model: 'grok-4.5', effort: 'high' } },
    }, registry);
    assert.equal(adapted.catalog.providerMutable, false);
    assert.equal(adapted.catalog.mutationEnabled, false);
    assert.match(adapted.catalog.mutationDisabledReason ?? '', /profile-aware/);
    assert.deepEqual(adapted.catalog.providerOptions.map(item => item.value), ['private-profile']);
    assert.equal(revalidateModelSelection(adapted.selection, {
        ...adapted.selection, provider: 'unregistered-profile', model: 'grok-4.3',
    }, adapted.catalog).provider, 'private-profile');
});

test('unknown current models stay synthetic while missing or empty registries block mutation', () => {
    const unknown = adaptModelSettings({
        cli: 'ai-e', perCli: { 'ai-e': { provider: 'codex', model: 'future-model', effort: 'high' } },
    }, registry);
    assert.equal(unknown.catalog.mutationEnabled, true);
    assert.equal(unknown.catalog.modelOptions.find(item => item.value === 'future-model')?.synthetic, true);

    const missing = adaptModelSettings({
        cli: 'custom', perCli: { custom: { model: 'still-visible', effort: '' } },
        telegram: { botToken: SECRET }, discord: { token: SECRET }, apiKeys: { openai: SECRET },
    }, {});
    assert.equal(missing.selection.model, 'still-visible');
    assert.equal(missing.catalog.mutationEnabled, false);
    assert.match(missing.catalog.mutationDisabledReason ?? '', /unavailable/);

    const empty = adaptModelSettings({
        cli: 'custom', perCli: { custom: { model: 'still-visible' } },
    }, { custom: { models: [], efforts: [], token: SECRET } });
    assert.equal(empty.catalog.mutationEnabled, false);
    assert.match(empty.catalog.mutationDisabledReason ?? '', /no live model inventory/);
});

test('secret canaries never enter the controlled adapter output', () => {
    const adapted = adaptModelSettings({
        cli: 'ai-e',
        perCli: { 'ai-e': { provider: 'claude', model: 'sonnet', effort: 'medium', apiKey: SECRET } },
        activeOverrides: { 'ai-e': { model: 'sonnet', effort: 'medium', managerToken: SECRET } },
        telegram: { botToken: SECRET },
        discord: { token: SECRET },
        pi: { profiles: [{ apiKey: SECRET }] },
    }, registry);
    assert.equal(JSON.stringify(adapted).includes(SECRET), false);
    assert.deepEqual(Object.keys(adapted.selection).sort(), ['cli', 'effort', 'model', 'provider']);
});
