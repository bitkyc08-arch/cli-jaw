import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyInput, flushPendingEscape } from '../../bin/commands/tui/input-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { appendTextToComposer, getComposerDisplayText } from '../../src/cli/tui/composer.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';

function makeCtx(sent: string[] = []): TuiContext {
    return {
        ws: {
            send(payload: string) { sent.push(payload); },
            close() { /* no-op */ },
        },
        apiUrl: 'http://127.0.0.1:3457',
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160, keymapPreset: 'default', diffStyle: 'summary' },
        settingsSnapshot: { showReasoning: false, tui: { theme: 'dark', fullscreen: true } },
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

function captureStdout<T>(fn: () => T): { result: T; writes: string } {
    const originalWrite = process.stdout.write;
    let writes = '';
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        writes += String(chunk);
        const cb = args.find((arg): arg is () => void => typeof arg === 'function');
        cb?.();
        return true;
    }) as typeof process.stdout.write;
    try {
        return { result: fn(), writes };
    } finally {
        process.stdout.write = originalWrite;
    }
}

function flushAsyncCommands(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
    for (let i = 0; i < attempts; i += 1) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(condition(), true);
}

test('fullscreen Enter submits without writing line-mode separators or moving the composer block', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };
    appendTextToComposer(ctx.store.composer, 'hello');

    const { writes } = captureStdout(() => handleKeyInput(ctx, '\r'));

    assert.equal(writes, '');
    assert.deepEqual(sent.map(item => JSON.parse(item)), [{ type: 'send_message', text: 'hello' }]);
    assert.equal(getComposerDisplayText(ctx.store.composer), '');
    assert.equal(ctx.inputActive, false);
    assert.ok(frames >= 1);
    assert.equal(ctx.store.transcript.items.at(-1)?.type, 'user');
});

test('fullscreen empty Enter redraws in place without stdout writes', () => {
    const ctx = makeCtx();
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };

    const { writes } = captureStdout(() => handleKeyInput(ctx, '\r'));

    assert.equal(writes, '');
    assert.equal(ctx.inputActive, true);
    assert.equal(frames, 1);
});

test('fullscreen stop shortcut records status instead of printing into the frame', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };
    ctx.inputActive = false;

    const { writes } = captureStdout(() => handleKeyInput(ctx, '\x03'));

    assert.equal(writes, '');
    assert.deepEqual(sent.map(item => JSON.parse(item)), [{ type: 'stop' }]);
    assert.equal(ctx.inputActive, true);
    assert.equal(frames, 1);
    const last = ctx.store.transcript.items.at(-1);
    assert.equal(last?.type, 'status');
    if (last?.type === 'status') assert.match(last.text, /stopped/);
});

// ── 260703 tui_steer_esc_rca: ESC/Ctrl+C must stop a streaming turn even
// with the composer open (typing mid-stream used to turn both into a no-op
// resp. full-TUI exit). Composer draft must survive the stop. ──

test('ESC stops a streaming turn even while the composer is open, preserving the draft', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };
    ctx.streaming = true;
    ctx.inputActive = true;  // user started typing a steer draft mid-stream
    appendTextToComposer(ctx.store.composer, 'steer draft');

    const { writes } = captureStdout(() => flushPendingEscape(ctx));

    assert.equal(writes, '');
    assert.deepEqual(sent.map(item => JSON.parse(item)), [{ type: 'stop' }]);
    assert.equal(ctx.inputActive, true);
    assert.equal(getComposerDisplayText(ctx.store.composer), 'steer draft');
    const last = ctx.store.transcript.items.at(-1);
    assert.equal(last?.type, 'status');
    if (last?.type === 'status') assert.match(last.text, /stopped/);
});

test('ESC stops a streaming turn even while a slash command is in flight', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    ctx.requestFrame = () => { /* noop */ };
    ctx.streaming = true;
    ctx.inputActive = false;
    ctx.commandRunning = true;  // e.g. /steer awaiting the server

    captureStdout(() => flushPendingEscape(ctx));

    assert.deepEqual(sent.map(item => JSON.parse(item)), [{ type: 'stop' }]);
});

test('ESC during a slash command with no stream stays blocked', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    ctx.streaming = false;
    ctx.inputActive = false;
    ctx.commandRunning = true;

    captureStdout(() => flushPendingEscape(ctx));

    assert.deepEqual(sent, []);
});

test('ESC with composer open and no stream stays a no-op (no accidental stop)', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    ctx.streaming = false;
    ctx.inputActive = true;
    appendTextToComposer(ctx.store.composer, 'draft');

    captureStdout(() => flushPendingEscape(ctx));

    assert.deepEqual(sent, []);
    assert.equal(getComposerDisplayText(ctx.store.composer), 'draft');
});

test('Ctrl+C stops a streaming turn with composer open instead of exiting the TUI', () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    ctx.requestFrame = () => { /* noop */ };
    ctx.streaming = true;
    ctx.inputActive = true;
    appendTextToComposer(ctx.store.composer, 'steer draft');

    // If the old exit branch were taken this would call process.exit(0) and
    // kill the test run — surviving the call is part of the assertion.
    const { writes } = captureStdout(() => handleKeyInput(ctx, '\x03'));

    assert.equal(writes, '');
    assert.deepEqual(sent.map(item => JSON.parse(item)), [{ type: 'stop' }]);
    assert.equal(ctx.inputActive, true);
    assert.equal(getComposerDisplayText(ctx.store.composer), 'steer draft');
});

test('fullscreen known slash command does not submit as an agent message or user row', async () => {
    const sent: string[] = [];
    const ctx = makeCtx(sent);
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };
    appendTextToComposer(ctx.store.composer, '/ide off');

    const { writes } = captureStdout(() => handleKeyInput(ctx, '\r'));

    assert.equal(writes, '');
    assert.deepEqual(sent, []);
    assert.equal(ctx.store.transcript.items.some(item => item.type === 'user'), false);
    assert.equal(ctx.commandRunning, true);

    await waitFor(() => ctx.commandRunning === false);

    assert.equal(ctx.commandRunning, false);
    assert.equal(ctx.inputActive, true);
    assert.equal(getComposerDisplayText(ctx.store.composer), '');
    assert.ok(frames >= 2);
    assert.equal(ctx.store.transcript.items.some(item => item.type === 'thinking'), false);
    const commands = ctx.store.transcript.items.filter(item => item.type === 'command');
    assert.ok(commands.length >= 1);
    assert.equal(commands[0]?.type, 'command');
    if (commands[0]?.type === 'command') {
        assert.equal(commands[0].commandName, 'ide');
        assert.equal(commands[0].ok, true);
        assert.ok(commands[0].text.length > 0);
    }
});

test('fullscreen unknown slash command restores input instead of staying command-running', async () => {
    const ctx = makeCtx();
    ctx.apiUrl = 'http://127.0.0.1:9';
    appendTextToComposer(ctx.store.composer, '/definitely-not-a-command');

    const { writes } = captureStdout(() => handleKeyInput(ctx, '\r'));

    assert.equal(writes, '');
    assert.equal(ctx.store.transcript.items.some(item => item.type === 'user'), false);
    await waitFor(() => ctx.commandRunning === false);

    assert.equal(ctx.commandRunning, false);
    assert.equal(ctx.inputActive, true);
    const last = ctx.store.transcript.items.at(-1);
    assert.equal(last?.type, 'command');
    if (last?.type === 'command') {
        assert.equal(last.ok, false);
        assert.equal(last.commandName, 'definitely-not-a-command');
    }
});
