// Settings channel switch integration tests — Phase 6
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessengerChannel } from '../../src/messaging/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const runtimeSrc = readFileSync(join(projectRoot, 'src/messaging/runtime.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');
const configSrc = readFileSync(join(projectRoot, 'src/core/config.ts'), 'utf8');
const pipelineSrc = readFileSync(join(projectRoot, 'src/orchestrator/pipeline.ts'), 'utf8');

// ─── Channel switch triggers restart ────────────────
//
// These two used to grep runtime.ts for `channelSwitched` and a
// `prevChannel !== nextChannel` comparison. Both names died with the single-channel
// model: enablement is now a set, so a "switch" is a set difference and the restart
// touches only the channels that actually moved. Asserting the behaviour instead of
// the identifiers keeps the contract and survives the next rename.

type Recorded = { channel: MessengerChannel; event: 'init' | 'shutdown' };

async function withStubbedTransports(
    run: (calls: Recorded[], runtime: typeof import('../../src/messaging/runtime.js')) => Promise<void>,
): Promise<void> {
    const runtime = await import('../../src/messaging/runtime.js');
    const calls: Recorded[] = [];
    runtime.__resetTransportRegistryForTests();
    for (const channel of ['telegram', 'discord', 'slack'] as MessengerChannel[]) {
        runtime.registerTransport(channel, {
            init: async () => { calls.push({ channel, event: 'init' }); return true; },
            shutdown: async () => { calls.push({ channel, event: 'shutdown' }); },
        });
    }
    try {
        await run(calls, runtime);
    } finally {
        runtime.__resetTransportRegistryForTests();
    }
}

const snapshot = (...enabled: MessengerChannel[]) => ({
    messaging: { enabledChannels: enabled, homeChannel: enabled[0] ?? 'telegram' },
});

test('restartMessagingRuntime starts newly enabled channels and stops disabled ones', async () => {
    await withStubbedTransports(async (calls, runtime) => {
        await runtime.startMessagingTransport('telegram');
        calls.length = 0;
        await runtime.restartMessagingRuntime(
            snapshot('telegram'),
            snapshot('slack'),
            {},
        );
        assert.deepEqual(calls, [
            { channel: 'telegram', event: 'shutdown' },
            { channel: 'slack', event: 'init' },
        ]);
    });
});

test('restartMessagingRuntime leaves untouched channels running', async () => {
    await withStubbedTransports(async (calls, runtime) => {
        await runtime.startMessagingTransport('telegram');
        await runtime.startMessagingTransport('slack');
        calls.length = 0;
        await runtime.restartMessagingRuntime(
            snapshot('telegram', 'slack'),
            snapshot('telegram', 'slack', 'discord'),
            {},
        );
        assert.deepEqual(calls, [{ channel: 'discord', event: 'init' }]);
        assert.deepEqual(runtime.getRunningMessagingTransports().sort(), ['discord', 'slack', 'telegram']);
    });
});

// ─── Restart clears stale targets ───────────────────

test('restart clears target state for the channels it touches', async () => {
    await withStubbedTransports(async (_calls, runtime) => {
        const telegramTarget = {
            channel: 'telegram' as const,
            targetKind: 'user' as const,
            peerKind: 'direct' as const,
            targetId: '111',
        };
        const slackTarget = {
            channel: 'slack' as const,
            targetKind: 'channel' as const,
            peerKind: 'channel' as const,
            targetId: 'C111',
        };
        runtime.setLastActiveTarget('telegram', telegramTarget);
        runtime.setLastActiveTarget('slack', slackTarget);
        await runtime.restartMessagingRuntime(
            snapshot('telegram', 'slack'),
            snapshot('slack'),
            {},
        );
        assert.equal(runtime.getLastActiveTarget('telegram'), null,
            'a disabled channel must not keep a target that could route a later reply');
        assert.deepEqual(runtime.getLastActiveTarget('slack'), slackTarget,
            'an untouched channel keeps its target');
        runtime.clearTargetState();
    });
});

// ─── Fresh home env-only Discord boot ──────────────

test('env-only Discord boot works without settings.json', () => {
    // loadSettings catch path must apply env overrides
    const loadSettingsFn = configSrc.slice(
        configSrc.indexOf('export function loadSettings'),
        configSrc.indexOf('\nexport function saveSettings'),
    );
    assert.match(loadSettingsFn, /catch\s*\([^)]*\)\s*{[\s\S]*applyEnvOverrides\(next\)/,
        'loadSettings catch path must apply env overrides for fresh-home boot');
});

test('DISCORD_TOKEN auto-switches channel when telegram disabled', () => {
    assert.match(configSrc, /channel.*=.*'discord'/,
        'should auto-switch to discord when telegram is not configured');
});

// ─── Failed restart rolls back settings ─────────────

// The old form grepped for replaceSettings(prevSnapshot), a call that stopped
// existing when persistence moved to write-then-commit. What it protected is
// unchanged, so assert the outcome: a failed restart must undo the patch and
// still surface the error. Writes go to an injected sink because the suite
// shares one temp home across files.
// The rollback contract for this path is asserted in
// tests/unit/cli-switch-refresh.test.ts, which owns the settings-mutation
// cases. They share process-wide settings state and the database, so
// splitting them across files made them race on a SQLite lock rather than
// on anything they were checking.
// ─── Pipeline broadcasts include target ─────────────

test('orchestrate_done broadcasts include target for queue correlation', () => {
    // Count occurrences of target in orchestrate_done broadcasts
    const broadcasts = pipelineSrc.match(/broadcast\('orchestrate_done'[\s\S]*?\}\)/g) || [];
    assert.ok(broadcasts.length >= 3, `expected at least 3 orchestrate_done broadcasts, got ${broadcasts.length}`);
    const withTarget = broadcasts.filter(b => b.includes('target'));
    assert.equal(withTarget.length, broadcasts.length,
        `all orchestrate_done broadcasts must include target, but only ${withTarget.length}/${broadcasts.length} do`);
});
