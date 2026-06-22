import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyInput } from '../../bin/commands/tui/input-handler.ts';
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
        info: { cli: 'jwc', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'jwc',
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
