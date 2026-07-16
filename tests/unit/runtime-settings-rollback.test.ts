import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'cli-jaw-runtime-settings-rollback-'));
process.env.CLI_JAW_HOME = tempHome;

const refreshError = new Error('forced cli switch refresh rejection');
let refreshCalls = 0;

test.mock.module('../../src/core/compact.ts', {
    exports: {
        cliSwitchRefresh: async () => {
            refreshCalls += 1;
            throw refreshError;
        },
    },
});
test.mock.module('../../src/prompt/builder.ts', {
    exports: { regenerateB: () => {} },
});

test.after(() => {
    rmSync(tempHome, { recursive: true, force: true });
});

test('RSR-001: cliSwitchRefresh rejection restores nested runtime and persisted settings exactly', async () => {
    const config = await import('../../src/core/config.ts');
    const { applyRuntimeSettingsPatch } = await import('../../src/core/runtime-settings.ts');
    const initial = {
        cli: 'ai-e',
        workingDir: tempHome,
        perCli: {
            'ai-e': {
                provider: 'codex',
                model: 'gpt-5.4',
                effort: 'medium',
            },
        },
        activeOverrides: {
            'ai-e': {
                provider: 'codex',
                model: 'gpt-5.5',
                effort: 'high',
            },
        },
    };
    config.saveSettings(structuredClone(initial));

    await assert.rejects(
        applyRuntimeSettingsPatch({
            perCli: {
                'ai-e': {
                    provider: 'grok',
                    model: 'grok-build',
                    effort: 'low',
                },
            },
            activeOverrides: {
                'ai-e': {
                    provider: 'grok',
                    model: 'grok-composer-2.5-fast',
                    effort: 'xhigh',
                },
            },
        }),
        refreshError,
    );

    assert.equal(refreshCalls, 1);
    assert.deepEqual(config.settings.perCli['ai-e'], initial.perCli['ai-e']);
    assert.deepEqual(config.settings.activeOverrides['ai-e'], initial.activeOverrides['ai-e']);

    const persisted = JSON.parse(readFileSync(join(tempHome, 'settings.json'), 'utf8'));
    assert.deepEqual(persisted.perCli['ai-e'], initial.perCli['ai-e']);
    assert.deepEqual(persisted.activeOverrides['ai-e'], initial.activeOverrides['ai-e']);
});
