// ─── TUI rendering of steer/retry/schedule/goal lifecycle events ─────────
// (260703 tui_steer_esc_rca doc 30 §A3) These explain why the current stream
// died or restarted; the Web UI renders them, the TUI used to drop them.
// Also covers the queue_update item cache feeding /queue (§A1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: '',
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160 },
        settingsSnapshot: {},
        values: { port: '3457', raw: false, simple: false },
        isRaw: false,
        store: createTuiStore(),
        overlayBoxHeight: 0,
        inputActive: true,
        streaming: false,
        streamState: 'idle',
        bgtaskCount: 0,
        bgtaskTasks: [],
        turnStartedAt: 0,
        streamSink: null,
        commandRunning: false,
        escPending: false,
        escTimer: null,
        footerTimer: null,
        editorChordPending: false,
        prevLineCount: 1,
        promptCursorRow: 0,
        resizeTimer: null,
        ideEnabled: false,
        idePopEnabled: false,
        preFileSetQueue: [],
        chatCwd: '/tmp/project',
        isGit: false,
        detectedIde: null,
        promptPrefix: '  > ',
        footer: 'footer',
        displayMode: 'fullscreen',
        requestFrame: null,
    } as unknown as TuiContext;
}

function send(ctx: TuiContext, value: Record<string, unknown>): void {
    handleWsMessage(ctx, Buffer.from(JSON.stringify(value)));
}

function lastStatusText(ctx: TuiContext): string {
    const statuses = ctx.store.transcript.items.filter(i => i.type === 'status');
    const last = statuses.at(-1);
    return last && 'text' in last ? String(last.text) : '';
}

test('steer_started renders a status line with origin and prompt preview', () => {
    const ctx = makeCtx();
    send(ctx, { type: 'steer_started', prompt: 'redirect the work to the failing test', origin: 'web' });
    assert.match(lastStatusText(ctx), /steer \(web\): redirect the work/);
});

test('agent_retry renders delayed and immediate variants', () => {
    const ctx = makeCtx();
    send(ctx, { type: 'agent_retry', cli: 'codex', delay: 30, reason: 'rate_limited' });
    assert.match(lastStatusText(ctx), /codex rate_limited — retry in 30s/);
    send(ctx, { type: 'agent_retry', cli: 'codex', delay: 0, reason: 'stale resume' });
    assert.match(lastStatusText(ctx), /codex stale resume — retrying/);
});

test('schedule_wakeup and failure variant render', () => {
    const ctx = makeCtx();
    send(ctx, { type: 'schedule_wakeup', delaySeconds: 120, reason: 'goal continuation' });
    assert.match(lastStatusText(ctx), /wakeup in 120s — goal continuation/);
    send(ctx, { type: 'schedule_wakeup_failed', reason: 'goal continuation', error: 'spawn failed' });
    assert.match(lastStatusText(ctx), /wakeup failed — goal continuation: spawn failed/);
});

test('goal gate events render with their detail field', () => {
    const ctx = makeCtx();
    send(ctx, { type: 'goal_pause_gate_pending', goalId: 'g1', reason: 'pause_gate_pending' });
    assert.match(lastStatusText(ctx), /Goal: pause_gate_pending — pause_gate_pending/);
    send(ctx, { type: 'goal_continuation_limit', attempts: 5 });
    assert.match(lastStatusText(ctx), /Goal: continuation_limit — 5 attempts/);
    send(ctx, { type: 'goal_continuation_failed', error: 'spawn error' });
    assert.match(lastStatusText(ctx), /Goal: continuation_failed — spawn error/);
    send(ctx, { type: 'goal_cancel', goalId: 'g1', source: 'ai_output' });
    assert.match(lastStatusText(ctx), /Goal: cancel — ai_output/);
});

test('queue_update caches the item snapshot including the empty update', () => {
    const ctx = makeCtx();
    send(ctx, {
        type: 'queue_update',
        pending: 2,
        queued: [
            { id: 'q1', prompt: 'first', source: 'web', ts: 1 },
            { id: 'q2', prompt: 'second', source: 'cli', ts: 2 },
        ],
    });
    assert.deepEqual(ctx.queueItems?.map(i => i.id), ['q1', 'q2']);
    // Drained queue must clear the cache — ghost items would mislead /queue.
    send(ctx, { type: 'queue_update', pending: 0, queued: [] });
    assert.deepEqual(ctx.queueItems, []);
});
