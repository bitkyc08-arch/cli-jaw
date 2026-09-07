import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON,
    readJwcModelProfilePresetInfo,
} from '../../src/code-mode/model-options.ts';

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
