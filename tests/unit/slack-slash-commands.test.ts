import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The plan's Phase-3 acceptance matrix: slash commands must route through the
// SHARED parseCommand/executeCommand pipeline, not forward raw text. Isolated
// in its own file because these tests mock the command pipeline modules.

type Posted = { channel: string; text: string };

// Module mocks are installed ONCE (the module graph is only evaluated once per
// process), so the fakes read mutable state that each test resets.
const state: {
    posted: Posted[];
    parsedSeen: string[];
    executeResult: { text?: string; steerPrompt?: string } | null;
    onExecute?: (parsed: unknown, ctx: { interface?: string }) => void;
    onOrchestrate?: (prompt: string, meta: Record<string, unknown>) => void;
} = { posted: [], parsedSeen: [], executeResult: { text: 'command output' } };

mock.module('../../src/slack/send-only-client.ts', {
    namedExports: {
        getSlackSendClient: () => ({ token: 'xoxb-test' }),
        sendSlackText: async (_token: string, target: { targetId: string }, text: string) => {
            state.posted.push({ channel: target.targetId, text });
            return { ok: true };
        },
        resolveSlackDmChannel: async () => ({ ok: true, channelId: 'D1' }),
        invalidateSlackSendClient: () => { /* no-op */ },
    },
});
mock.module('../../src/cli/commands.ts', {
    namedExports: {
        parseCommand: (text: string) => {
            state.parsedSeen.push(text);
            return text.startsWith('/') ? { type: 'known', name: text.slice(1).split(' ')[0] } : null;
        },
        executeCommand: async (parsed: unknown, ctx: { interface?: string }) => {
            state.onExecute?.(parsed, ctx);
            return state.executeResult;
        },
    },
});
mock.module('../../src/orchestrator/collect.ts', {
    namedExports: {
        orchestrateAndCollect: async (prompt: string, meta: Record<string, unknown>) => {
            state.onOrchestrate?.(prompt, meta);
            return 'steered reply';
        },
    },
});

async function loadHandler(options: {
    executeResult?: { text?: string; steerPrompt?: string } | null;
    channelIds?: string[];
    onExecute?: (parsed: unknown, ctx: { interface?: string }) => void;
    onOrchestrate?: (prompt: string, meta: Record<string, unknown>) => void;
} = {}) {
    state.posted = [];
    state.parsedSeen = [];
    state.executeResult = options.executeResult === undefined ? { text: 'command output' } : options.executeResult;
    state.onExecute = options.onExecute ?? undefined;
    state.onOrchestrate = options.onOrchestrate ?? undefined;

    const { settings } = await import('../../src/core/config.ts');
    (settings as Record<string, unknown>)['slack'] = {
        enabled: true,
        botToken: 'xoxb-test',
        channelIds: options.channelIds ?? [],
    };

    const { handleSlackSlashCommand } = await import('../../src/slack/commands.ts');
    return { handleSlackSlashCommand, posted: state.posted, parsedSeen: state.parsedSeen };
}

test('a slash command reaches executeCommand with a slack context', async () => {
    let seenInterface: string | undefined;
    const { handleSlackSlashCommand, posted, parsedSeen } = await loadHandler({
        onExecute: (_p, ctx) => { seenInterface = ctx.interface; },
    });
    await handleSlackSlashCommand({ command: '/status', text: '', channel_id: 'C1' });

    assert.deepEqual(parsedSeen, ['/status'], 'command and args must be joined for the shared parser');
    assert.equal(seenInterface, 'slack', 'the command context must identify slack');
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.text, 'command output');
});

test('slash command arguments are joined onto the command name', async () => {
    const { handleSlackSlashCommand, parsedSeen } = await loadHandler();
    await handleSlackSlashCommand({ command: '/model', text: 'gpt-5.5', channel_id: 'C1' });
    assert.deepEqual(parsedSeen, ['/model gpt-5.5']);
});

test('a steerPrompt result orchestrates with the slack target preserved', async () => {
    let meta: Record<string, unknown> | null = null;
    const { handleSlackSlashCommand, posted } = await loadHandler({
        executeResult: { text: 'redirecting', steerPrompt: 'do the new thing' },
        onOrchestrate: (_p, m) => { meta = m; },
    });
    await handleSlackSlashCommand({ command: '/steer', text: 'do the new thing', channel_id: 'C7' });

    assert.ok(meta, 'orchestrateAndCollect was never called');
    const captured = meta as unknown as Record<string, unknown>;
    assert.equal(captured['origin'], 'slack');
    const target = captured['target'] as { channel?: string; targetId?: string };
    assert.equal(target.channel, 'slack');
    assert.equal(target.targetId, 'C7', 'the steer path must keep the originating conversation');
    assert.deepEqual(posted.map(p => p.text), ['redirecting', 'steered reply']);
});

test('a slash command from a non-allowlisted channel never executes', async () => {
    // Without this gate a slash command would bypass the allowlist that the
    // ordinary message path enforces.
    let executed = false;
    const { handleSlackSlashCommand, posted } = await loadHandler({
        channelIds: ['C123'],
        onExecute: () => { executed = true; },
    });
    await handleSlackSlashCommand({ command: '/status', text: '', channel_id: 'C999' });
    assert.equal(executed, false, 'allowlist bypassed via slash command');
    assert.equal(posted.length, 0, 'a blocked command must stay silent');
});

test('a slash command from a DM proceeds despite a non-matching allowlist', async () => {
    let executed = false;
    const { handleSlackSlashCommand } = await loadHandler({
        channelIds: ['C123'],
        onExecute: () => { executed = true; },
    });
    await handleSlackSlashCommand({ command: '/status', text: '', channel_id: 'D555' });
    assert.equal(executed, true, 'DMs are self-authorizing and must not be blocked');
});

test('an empty result still posts something rather than going silent', async () => {
    const { handleSlackSlashCommand, posted } = await loadHandler({ executeResult: null });
    await handleSlackSlashCommand({ command: '/status', text: '', channel_id: 'C1' });
    assert.equal(posted[0]!.text, '(no output)');
});

test('a payload missing its command id is ignored', async () => {
    const { handleSlackSlashCommand, posted } = await loadHandler();
    await handleSlackSlashCommand({ text: 'orphan', channel_id: 'C1' });
    assert.equal(posted.length, 0);
});
