import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON,
    readJwcModelProfilePresetInfo,
} from '../../src/code-mode/model-options.ts';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

test('JWC model profile preset info reads default profile and task presets', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-presets-'));
    try {
        await writeFile(join(agentDir, 'config.yml'), [
            'modelProfile:',
            '  default: codex-standard',
            'task:',
            '  modelPresets:',
            '    frontend:',
            '      best: openai-codex/gpt-5.4:xhigh',
            '      cheap: openai-codex/gpt-5.4-mini',
            '    docs:',
            '      cheap: anthropic/claude-haiku-4-5',
            '',
        ].join('\n'), 'utf8');

        const info = await readJwcModelProfilePresetInfo(agentDir);
        assert.equal(info.defaultProfile, 'codex-standard');
        assert.deepEqual(info.taskPresets, [
            { name: 'docs', cheap: 'anthropic/claude-haiku-4-5' },
            { name: 'frontend', best: 'openai-codex/gpt-5.4:xhigh', cheap: 'openai-codex/gpt-5.4-mini' },
        ]);
        assert.equal(info.applyAvailable, false);
        assert.equal(info.applyReason, JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON);
        assert.ok(info.builtinProfiles.some(profile => profile.name === 'codex-standard'));
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('code model preset route and client are read-only', () => {
    const routes = read('src/routes/code.ts');
    const client = read('public/manager/src/code/code-session-client.ts');
    const modelOptions = read('src/code-mode/model-options.ts');

    assert.ok(modelOptions.includes('readJwcModelProfilePresetInfo'), 'helper must expose preset readback');
    assert.ok(modelOptions.includes('JWC_BUILTIN_MODEL_PROFILE_NAMES'), 'helper must expose built-in profile candidates');
    assert.ok(modelOptions.includes('JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON'), 'helper must explain deferred profile apply');
    assert.ok(routes.includes("app.get('/api/code/model-presets'"), 'server must expose read-only model preset route');
    assert.equal(routes.includes("app.post('/api/code/model-presets'"), false, 'preset route must not write presets in this slice');
    assert.equal(routes.includes('modelProfile.default'), false, 'route must not write modelProfile.default in this slice');
    assert.ok(client.includes('CodeModelPresetInfo'), 'client must type preset/profile info');
    assert.ok(client.includes('listModelPresets()'), 'client must expose preset read method');
    assert.ok(client.includes("request<CodeModelPresetInfo>('GET', '/api/code/model-presets')"), 'client must call read-only route');
});
