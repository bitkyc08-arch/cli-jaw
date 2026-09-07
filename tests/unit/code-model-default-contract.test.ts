import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildJwcModelOptions,
    parseJwcModelRole,
    readJwcDefaultModelRole,
    writeJwcDefaultModelRole,
} from '../../src/code-mode/model-options.ts';

test('JWC default model helper creates modelRoles.default in config.yml', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-default-'));
    try {
        await writeJwcDefaultModelRole('openai-codex/gpt-5.4', agentDir);

        assert.equal(await readJwcDefaultModelRole(agentDir), 'openai-codex/gpt-5.4');
        assert.match(await readFile(join(agentDir, 'config.yml'), 'utf8'), /modelRoles:\n\s+default: openai-codex\/gpt-5\.4/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC default model helper preserves unrelated config keys', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-default-'));
    try {
        await writeFile(join(agentDir, 'config.yml'), 'theme:\n  dark: mono\nmodelRoles:\n  smol: anthropic/claude-haiku-4-5\n', 'utf8');
        await writeJwcDefaultModelRole('fireworks/accounts/fireworks/models/deepseek-v3', agentDir);
        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');

        assert.match(content, /theme:\n\s+dark: mono/);
        assert.match(content, /smol: anthropic\/claude-haiku-4-5/);
        assert.match(content, /default: fireworks\/accounts\/fireworks\/models\/deepseek-v3/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model role parser follows first slash and valid thinking suffix contract', () => {
    assert.deepEqual(parseJwcModelRole('fireworks/accounts/fireworks/models/deepseek-v3'), {
        provider: 'fireworks',
        model: 'accounts/fireworks/models/deepseek-v3',
    });
    assert.deepEqual(parseJwcModelRole('openai-codex/gpt-5.4:high'), {
        provider: 'openai-codex',
        model: 'gpt-5.4',
        thinkingLevel: 'high',
    });
    assert.deepEqual(parseJwcModelRole('openrouter/anthropic/claude:beta'), {
        provider: 'openrouter',
        model: 'anthropic/claude:beta',
    });
});

test('code model options use valid authenticated configured default', () => {
    const options = buildJwcModelOptions(['anthropic', 'fireworks'], undefined, 'fireworks/accounts/fireworks/models/deepseek-v3:high');

    assert.equal(options.defaultProvider, 'fireworks');
    assert.equal(options.defaultModel, 'accounts/fireworks/models/deepseek-v3');
});

// ─── JWC unconfigured fallback derives from the provider list ─────
// The fallback used to be a literal, claude-sonnet-4-6, which had drifted to seventh in
// the anthropic default list and a generation behind its head. Nothing linked the two, so
// a catalog refresh could not carry it. These tests pin the derivation, not a version
// string, so they keep passing when the catalog moves and fail if the link is cut.

async function runJwcSync(settings: Record<string, unknown>): Promise<string | null> {
    const { syncJwcConfigDefault } = await import('../../src/core/runtime-settings.ts');
    const dir = await mkdtemp(join(tmpdir(), 'jaw-jwc-default-'));
    const prev = process.env['CLI_JAW_JWC_AGENT_DIR'];
    process.env['CLI_JAW_JWC_AGENT_DIR'] = dir;
    try {
        syncJwcConfigDefault(settings as Record<string, any>);
        return await readFile(join(dir, 'config.yml'), 'utf8').catch(() => null);
    } finally {
        if (prev === undefined) delete process.env['CLI_JAW_JWC_AGENT_DIR'];
        else process.env['CLI_JAW_JWC_AGENT_DIR'] = prev;
        await rm(dir, { recursive: true, force: true });
    }
}

test('CMDC-JWC-001: an unconfigured jwc writes the head of the provider default list', async () => {
    const { JWC_PROVIDER_MODEL_DEFAULTS } = await import('../../src/code-mode/model-options.ts');
    const expected = JWC_PROVIDER_MODEL_DEFAULTS['anthropic']?.[0];
    assert.ok(expected, 'anthropic must have a default list to derive from');
    const written = await runJwcSync({ cli: 'jwc' });
    assert.ok(written, 'config.yml should be written');
    assert.match(written!, /modelRoles:/);
    assert.match(written!, new RegExp(`default: anthropic/${expected!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
});

test('CMDC-JWC-002: the fallback is not the stale literal', async () => {
    const written = await runJwcSync({ cli: 'jwc' });
    const { JWC_PROVIDER_MODEL_DEFAULTS } = await import('../../src/code-mode/model-options.ts');
    // Only meaningful while sonnet-4-6 is NOT the head; if a future refresh makes it the
    // head again this assertion correctly stops applying rather than failing wrongly.
    if (JWC_PROVIDER_MODEL_DEFAULTS['anthropic']?.[0] !== 'claude-sonnet-4-6') {
        assert.doesNotMatch(written!, /claude-sonnet-4-6/);
    }
});

test('CMDC-JWC-003: an explicit model still wins over the derived default', async () => {
    const written = await runJwcSync({ cli: 'jwc', perCli: { jwc: { model: 'claude-opus-5', provider: 'anthropic' } } });
    assert.match(written!, /default: anthropic\/claude-opus-5\b/);
    const overridden = await runJwcSync({
        cli: 'jwc',
        perCli: { jwc: { model: 'claude-opus-5' } },
        activeOverrides: { jwc: { model: 'claude-sonnet-5' } },
    });
    assert.match(overridden!, /default: anthropic\/claude-sonnet-5\b/);
});

test('CMDC-JWC-004: an unknown provider writes nothing rather than a model it lacks', async () => {
    // The old literal was written for ANY provider, so an unknown one got
    // `<provider>/claude-sonnet-4-6` -- a model that provider does not have. Writing
    // nothing is the better failure.
    const written = await runJwcSync({ cli: 'jwc', perCli: { jwc: { provider: 'no-such-provider' } } });
    assert.equal(written, null);
});

test('CMDC-JWC-005: a non-jwc cli is untouched', async () => {
    assert.equal(await runJwcSync({ cli: 'claude' }), null);
});
