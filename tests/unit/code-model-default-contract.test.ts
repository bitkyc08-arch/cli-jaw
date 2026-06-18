import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildJwcModelOptions,
    parseJwcModelRole,
    readJwcDefaultModelRole,
    writeJwcDefaultModelRole,
} from '../../src/code-mode/model-options.ts';
import { toModelId } from '../../public/manager/src/code/code-types.ts';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

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

test('code model selector formatter always preserves explicit provider', () => {
    assert.equal(toModelId('fireworks', 'accounts/fireworks/models/deepseek-v3'), 'fireworks/accounts/fireworks/models/deepseek-v3');
    assert.equal(toModelId('openai-codex', 'gpt-5.4'), 'openai-codex/gpt-5.4');
});

test('model popup exposes session-independent Set default path', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const client = read('public/manager/src/code/code-session-client.ts');
    const routes = read('src/routes/code.ts');

    assert.ok(popup.includes('onSetDefaultModel'), 'popup must accept default persistence callback');
    assert.ok(popup.includes('Set default'), 'popup must expose Set default action');
    assert.equal(popup.includes('Set default, subagent assignment'), false, 'popup copy must not describe implemented Set default as future work');
    assert.ok(popup.includes('canSetDefault'), 'Set default must not require activeSessionId');
    assert.ok(canvas.includes('client.setDefaultModel(toModelId(nextProvider, nextModel))'), 'CodeCanvas must call default persistence API');
    assert.ok(client.includes("'/api/code/model-default'"), 'client must expose model-default route');
    assert.ok(routes.includes("app.post('/api/code/model-default'"), 'server must expose model-default route');
});
