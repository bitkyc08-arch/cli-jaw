import test from 'node:test';
import assert from 'node:assert/strict';
import {
    slackPeerKind,
    slackTargetKind,
    slackTargetFromId,
    resolveSlackThreadTs,
} from '../../src/messaging/slack-target.ts';
import { DEFAULT_SETTINGS, migrateSettings, settings } from '../../src/core/config.ts';
import { validateTarget } from '../../src/messaging/send.ts';
import { getTransportCapability, buildChannelHealthSnapshot } from '../../src/messaging/channel-health.ts';
import { slackApi } from '../../src/slack/api.ts';

// ─── Settings schema ────────────────────────────────

test('defaults include a complete slack block', () => {
    const sc = (DEFAULT_SETTINGS as Record<string, any>)['slack'];
    assert.ok(sc, 'slack defaults missing');
    assert.equal(sc.enabled, false);
    assert.equal(sc.botToken, '');
    assert.equal(sc.appToken, '');
    // Slack bots live in shared channels; answering everything is antisocial.
    assert.equal(sc.mentionOnly, true, 'slack mentionOnly must default true');
    assert.equal(sc.replyInThread, true, 'slack replyInThread must default true');
    assert.equal(sc.inboundDownloadConcurrency, 6);
});

test('migration normalizes inboundDownloadConcurrency to an integer from 1 through 32', () => {
    for (const value of [undefined, 0, 33, 1.5, '6', Number.NaN]) {
        const migrated = migrateSettings({ slack: { inboundDownloadConcurrency: value } }) as Record<string, any>;
        assert.equal(migrated['slack'].inboundDownloadConcurrency, 6, String(value));
    }
    for (const value of [1, 6, 32]) {
        const migrated = migrateSettings({ slack: { inboundDownloadConcurrency: value } }) as Record<string, any>;
        assert.equal(migrated['slack'].inboundDownloadConcurrency, value);
    }
});

test('slackApi composes optional cancellation without changing optionless RequestInit', async () => {
    const captured: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        captured.push(init || {});
        return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const source = new AbortController();

    await slackApi('token', 'auth.test', undefined, { fetchImpl });
    await slackApi('token', 'auth.test', undefined, { fetchImpl, signal: source.signal });
    await slackApi('token', 'auth.test', undefined, { fetchImpl, timeoutMs: 30_000 });
    await slackApi('token', 'auth.test', undefined, { fetchImpl, signal: source.signal, timeoutMs: 30_000 });

    assert.equal('signal' in captured[0]!, false);
    assert.equal(captured[1]!.signal, source.signal);
    assert.ok(captured[2]!.signal instanceof AbortSignal);
    assert.ok(captured[3]!.signal instanceof AbortSignal);
    assert.notEqual(captured[3]!.signal, source.signal);
    source.abort();
    assert.equal(captured[3]!.signal!.aborted, true);
});

test('defaults carry slack messaging target slots', () => {
    const m = (DEFAULT_SETTINGS as Record<string, any>)['messaging'];
    assert.equal(m.latestSeen.slack, null);
    assert.equal(m.lastActive.slack, null);
});

test('migration adds a slack block to legacy settings', () => {
    const legacy: Record<string, any> = {
        channel: 'telegram',
        discord: { enabled: false, token: '' },
    };
    const migrated = migrateSettings(legacy) as Record<string, any>;
    assert.ok(migrated['slack'], 'migration did not add slack');
    assert.equal(migrated['slack'].mentionOnly, true);
    assert.equal(migrated['slack'].replyInThread, true);
});

test('migration backfills slack slots into an EXISTING messaging block', () => {
    // Regression guard: a bare `if (!s.messaging)` would never reach existing
    // installs, which all already have a messaging block.
    const legacy: Record<string, any> = {
        channel: 'telegram',
        messaging: {
            latestSeen: { telegram: null, discord: null },
            lastActive: { telegram: null, discord: null },
        },
    };
    const migrated = migrateSettings(legacy) as Record<string, any>;
    assert.equal(migrated['messaging'].latestSeen.slack, null);
    assert.equal(migrated['messaging'].lastActive.slack, null);
});

// ─── Target derivation ──────────────────────────────

test('slackPeerKind classifies by id prefix', () => {
    assert.equal(slackPeerKind('C12345'), 'channel');
    assert.equal(slackPeerKind('G12345'), 'group');
    assert.equal(slackPeerKind('D12345'), 'direct');
    // A user id is not a conversation, but it resolves to a DM.
    assert.equal(slackPeerKind('U12345'), 'direct');
    assert.equal(slackPeerKind('d12345'), 'direct', 'prefix match must be case-insensitive');
});

test('slackTargetKind maps direct conversations to user targets', () => {
    assert.equal(slackTargetKind('D123'), 'user');
    assert.equal(slackTargetKind('U123'), 'user');
    assert.equal(slackTargetKind('C123'), 'channel');
    assert.equal(slackTargetKind('G123'), 'channel');
});

test('slackTargetFromId omits threadId when no thread is supplied', () => {
    const target = slackTargetFromId('C123');
    assert.equal(target.channel, 'slack');
    assert.equal(target.targetId, 'C123');
    assert.ok(!('threadId' in target), 'threadId key must be absent, not undefined');
    assert.ok(!('guildId' in target));
});

test('slackTargetFromId carries thread and team when supplied', () => {
    const target = slackTargetFromId('C123', { threadTs: '1735.0001', teamId: 'T999' });
    assert.equal(target.threadId, '1735.0001');
    assert.equal(target.guildId, 'T999');
});

// ─── Threading (highest-risk rule in the unit) ──────

test('resolveSlackThreadTs starts a thread from a top-level message', () => {
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, true), '1.1');
});

test('resolveSlackThreadTs replies to the PARENT ts, never the reply ts', () => {
    // Slack requires the parent's ts. Using the reply's own ts breaks the thread.
    assert.equal(resolveSlackThreadTs({ ts: '2.2', thread_ts: '1.1' }, true), '1.1');
});

test('resolveSlackThreadTs with replyInThread off stays top-level', () => {
    assert.equal(resolveSlackThreadTs({ ts: '1.1' }, false), undefined);
    // Even when the INBOUND message arrived inside a thread, replyInThread:false
    // must post at conversation top level — otherwise the setting is a no-op for
    // the exact case it exists to control.
    assert.equal(resolveSlackThreadTs({ ts: '2.2', thread_ts: '1.1' }, false), undefined);
});

// ─── Allowlist ──────────────────────────────────────

function withSlackSettings<T>(patch: Record<string, unknown>, fn: () => T): T {
    const prior = (settings as Record<string, any>)['slack'];
    (settings as Record<string, any>)['slack'] = patch;
    try {
        return fn();
    } finally {
        (settings as Record<string, any>)['slack'] = prior;
    }
}

test('validateTarget lets a DM through an empty allowlist', () => {
    withSlackSettings({ enabled: true, channelIds: [] }, () => {
        const target = slackTargetFromId('D123');
        assert.equal(validateTarget(target, 'slack', { requireConfiguredAllowlist: true }), true);
    });
});

test('validateTarget lets a U-id through so the DM-open path can run', () => {
    withSlackSettings({ enabled: true, channelIds: ['C123'] }, () => {
        const target = slackTargetFromId('U777');
        assert.equal(validateTarget(target, 'slack', { requireConfiguredAllowlist: true }), true);
    });
});

test('validateTarget enforces the channel allowlist', () => {
    withSlackSettings({ enabled: true, channelIds: ['C123'] }, () => {
        assert.equal(validateTarget(slackTargetFromId('C123'), 'slack'), true);
        assert.equal(validateTarget(slackTargetFromId('C999'), 'slack'), false);
    });
});

test('validateTarget ignores a forged peerKind on a channel id', () => {
    // peerKind is caller-supplied metadata. If the DM bypass trusted it, a
    // disallowed channel could evade the allowlist by claiming to be a DM.
    withSlackSettings({ enabled: true, channelIds: ['C123'] }, () => {
        const forged = {
            channel: 'slack' as const,
            targetKind: 'user' as const,
            peerKind: 'direct' as const,
            targetId: 'C999',
        };
        assert.equal(validateTarget(forged, 'slack', { requireConfiguredAllowlist: true }), false);
    });
});

// ─── Health ─────────────────────────────────────────

test('slack health reports disabled without a bot token', () => {
    withSlackSettings({ enabled: false }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, false);
        assert.equal(cap.reason, 'disabled');
    });
});

test('slack health reports missing_app_token for outbound-only setups', () => {
    // Bot token alone: can post, can never receive. Say so precisely.
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', channelIds: ['C123'] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, true);
        assert.equal(cap.reason, 'missing_app_token');
        assert.equal(cap.sendCapable, true);
    });
});

test('slack health reports missing_channel_id with both tokens and no target', () => {
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', appToken: 'xapp-x', channelIds: [] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.sendCapable, false);
        assert.equal(cap.reason, 'missing_channel_id');
    });
});

test('slack health reports ready when fully configured', () => {
    withSlackSettings({ enabled: true, botToken: 'xoxb-x', appToken: 'xapp-x', channelIds: ['C123'] }, () => {
        const cap = getTransportCapability('slack');
        assert.equal(cap.configured, true);
        assert.equal(cap.sendCapable, true);
        assert.equal(cap.reason, undefined);
    });
});

test('channel health snapshot includes slack', () => {
    const snap = buildChannelHealthSnapshot();
    assert.ok('slack' in snap, 'health snapshot is missing the slack key');
});

// ─── Behavior: hydration, /forward, command catalog ─

test('hydrateTargetsFromSettings restores a persisted slack target', async () => {
    const { hydrateTargetsFromSettings, getLastActiveTarget, clearTargetState } =
        await import('../../src/messaging/runtime.ts');
    clearTargetState('slack');
    hydrateTargetsFromSettings({
        messaging: {
            lastActive: {
                slack: { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C777' },
            },
            latestSeen: {},
        },
    });
    const restored = getLastActiveTarget('slack');
    assert.ok(restored, 'slack target was not hydrated');
    assert.equal(restored.targetId, 'C777');
    clearTargetState('slack');
});

test('makeCommandCtx slack permits the /forward settings patch', async () => {
    // The remote-settings gate and /forward's own patch key must agree, or the
    // command is dead on arrival: accepted interface, rejected payload.
    const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
    let applied: Record<string, unknown> | null = null;
    const deps = {
        applySettings: async (patch: Record<string, unknown>) => {
            applied = patch;
            return { ok: true };
        },
    // justified: CommandContextDeps has many optional callbacks; this stub supplies only the one under test
    } as Parameters<typeof makeCommandCtx>[2];
    const ctx = makeCommandCtx('slack', 'ko', deps);
    const result = await ctx.updateSettings({ slack: { forwardAll: true } }) as { ok?: boolean };
    assert.equal(result?.ok, true, 'slack settings patch was rejected by the remote gate');
    assert.deepEqual(applied, { slack: { forwardAll: true } });
});

test('makeCommandCtx slack still rejects out-of-allowlist keys', async () => {
    const { makeCommandCtx } = await import('../../src/cli/command-context.ts');
    let called = false;
    const deps = {
        applySettings: async () => { called = true; return { ok: true }; },
    // justified: same partial-stub rationale as the test above
    } as Parameters<typeof makeCommandCtx>[2];
    const ctx = makeCommandCtx('slack', 'ko', deps);
    const result = await ctx.updateSettings({ workingDir: '/tmp' }) as { ok?: boolean };
    assert.equal(result?.ok, false);
    assert.equal(called, false, 'applySettings must not run for a disallowed key');
});

type ForwardCtxStub = Parameters<typeof import('../../src/cli/handlers-runtime.ts').forwardHandler>[1];

test('forwardHandler from slack writes settings.slack, not telegram', async () => {
    // Regression guard: before the slack arm existed, /forward from any
    // non-discord remote silently mutated Telegram's forwardAll.
    const { forwardHandler } = await import('../../src/cli/handlers-runtime.ts');
    let patch: Record<string, unknown> | null = null;
    const ctx = {
        interface: 'slack',
        locale: 'ko',
        getSettings: () => ({ channel: 'telegram', slack: { forwardAll: false } }),
        updateSettings: async (p: Record<string, unknown>) => { patch = p; return { ok: true }; },
    // justified: CliCommandContext is a wide runtime surface; this stub covers the fields forwardHandler reads
    } as unknown as ForwardCtxStub;
    const result = await forwardHandler(['on'], ctx);
    assert.deepEqual(patch, { slack: { forwardAll: true } });
    assert.match(String(result.text), /Slack/, 'reply must name Slack, not Telegram');
});

test('forwardHandler from slack reads slack state when querying', async () => {
    const { forwardHandler } = await import('../../src/cli/handlers-runtime.ts');
    const ctx = {
        interface: 'slack',
        locale: 'ko',
        getSettings: () => ({ channel: 'telegram', slack: { forwardAll: false }, telegram: { forwardAll: true } }),
        updateSettings: async () => ({ ok: true }),
    // justified: same partial-stub rationale as the test above
    } as unknown as ForwardCtxStub;
    const result = await forwardHandler([], ctx);
    assert.match(String(result.text), /Slack/);
    assert.match(String(result.text), /OFF/, 'must report slack.forwardAll, not telegram.forwardAll');
});

test('getVisibleCommands slack is non-empty and includes steer', async () => {
    // The catalog filters on capability[iface]; without a derived slack key
    // this returns an empty array while claiming Slack support.
    const { getVisibleCommands } = await import('../../src/command-contract/policy.ts');
    const names = getVisibleCommands('slack').map((c: { name: string }) => c.name);
    assert.ok(names.length > 0, 'slack command catalog is empty');
    assert.ok(names.includes('status'), 'slack catalog is missing status');
    // /steer carries an EXPLICIT capability map, which the derived-map fix alone
    // would not have reached.
    assert.ok(names.includes('steer'), 'slack catalog is missing steer');
});
