import '../setup/isolated-home.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { handleWsMessage } from '../../bin/commands/tui/ws-handler.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { renderStatusBar } from '../../src/cli/tui/presentation.ts';
import { isSpinning, stopSpinner } from '../../src/cli/tui/spinner.ts';
import { cleanupScrollRegion } from '../../src/cli/tui/shell.ts';

// Replaces the three source-spelling oracles with real handler/renderer calls.
// The stream builder and transcript implementation are intentionally not mocked.
function makeCtx(mode: 'line' | 'fullscreen', raw = false): TuiContext {
    return {
        ws: { transport: 'ws', send() {}, on() {}, close() {} },
        apiUrl: '', info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '', label: 'codex', dir: '/tmp/project', runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: mode === 'fullscreen', pasteCollapseLines: 2, pasteCollapseChars: 160 },
        settingsSnapshot: {}, values: { port: '3457', raw, simple: false }, isRaw: raw,
        store: createTuiStore(), overlayBoxHeight: 0, inputActive: false,
        streaming: false, streamState: 'idle', bgtaskCount: 0, bgtaskTasks: [],
        turnStartedAt: 0, streamSink: null, commandRunning: false,
        escPending: false, escTimer: null, footerTimer: null, editorChordPending: false,
        prevLineCount: 1, promptCursorRow: 0, resizeTimer: null,
        ideEnabled: false, idePopEnabled: false, preFileSetQueue: [],
        chatCwd: '/tmp/project', isGit: false, detectedIde: null, promptPrefix: '  > ',
        footer: renderStatusBar({ model: 'test-model', engine: 'codex', engineAccent: '', state: 'idle', cwd: '/tmp/project', port: 3457 }),
        displayMode: mode, requestFrame: null,
    };
}

function fixture(t: TestContext, mode: 'line' | 'fullscreen' = 'line', raw = false) {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
    const chunks: string[] = [];
    t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
    });
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden in TUI fixture'); });
    const ctx = makeCtx(mode, raw);
    let frames = 0;
    ctx.requestFrame = () => { frames++; };
    const send = (value: Record<string, unknown>) => handleWsMessage(ctx, Buffer.from(JSON.stringify(value)));
    return {
        ctx, send, frames: () => frames,
        output: () => stripVTControlCharacters(chunks.join('')),
        assertIdle: () => {
            assert.equal(ctx.streaming, false);
            assert.equal(ctx.streamState, 'idle');
            assert.equal(ctx.streamSink, null);
            assert.equal(ctx.footerTimer, null);
            assert.equal(ctx.inputActive, true);
            assert.equal(isSpinning(), false);
            const before = chunks.join('');
            const frameCount = frames;
            t.mock.timers.tick(1000);
            assert.equal(chunks.join(''), before, 'no footer/spinner writes after terminal cleanup');
            assert.equal(frames, frameCount, 'no footer frames after terminal cleanup');
        },
        dispose: () => {
            stopSpinner();
            if (ctx.footerTimer !== null) clearInterval(ctx.footerTimer);
            if (ctx.escTimer !== null) clearTimeout(ctx.escTimer);
            if (ctx.resizeTimer !== null) clearTimeout(ctx.resizeTimer);
            ctx.footerTimer = null;
            ctx.streamSink = null;
            if (mode === 'line') cleanupScrollRegion(); // captured, never touches the real terminal
            assert.equal(network.mock.callCount(), 0);
        },
    };
}

test('thinking deltas create only a thinking row and no line-mode answer sink', t => {
    const f = fixture(t);
    try {
        f.send({ type: 'agent_output', text: 'THOUGHT-ONE ', thinking: true, agentId: 'main' });
        const clock = f.ctx.turnStartedAt;
        const timer = f.ctx.footerTimer;
        t.mock.timers.tick(600);
        f.send({ type: 'agent_output', text: 'THOUGHT-TWO', thinking: true, agentId: 'main' });
        const items = f.ctx.store.transcript.items;
        assert.equal(items.length, 1);
        assert.equal(items[0]?.type, 'thinking');
        assert.ok(items[0]?.type === 'thinking');
        assert.equal(items[0].text, 'THOUGHT-ONE THOUGHT-TWO');
        assert.equal(items[0].streaming, true);
        assert.equal(f.ctx.streamSink, null);
        assert.equal(f.ctx.streaming, true);
        assert.equal(f.ctx.turnStartedAt, clock);
        assert.equal(f.ctx.footerTimer, timer);
        assert.ok(timer);
        assert.ok(!f.output().includes('THOUGHT-ONE'));
        f.send({ type: 'agent_done', text: '' });
        assert.equal(items[0].streaming, false);
        f.assertIdle();
    } finally { f.dispose(); }
});

test('same line context thinking -> assistant creates one working sink without restarting clock/footer', t => {
    const f = fixture(t);
    try {
        f.send({ type: 'agent_output', text: 'PRESERVED-THOUGHT', thinking: true, agentId: 'main' });
        const clock = f.ctx.turnStartedAt;
        const timer = f.ctx.footerTimer;
        t.mock.timers.tick(600);
        f.send({ type: 'agent_output', text: 'ANSWER-ONE\n\n', thinking: false, agentId: 'main' });
        const answers = f.ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.deepEqual(answers.map(item => item.text), ['ANSWER-ONE\n\n'], 'the same-context assistant reached its transcript');
        assert.ok(f.output().includes('ANSWER-ONE'), 'a complete markdown block must reach line-mode stdout after thinking');
        const sink = f.ctx.streamSink;
        assert.ok(sink, 'first assistant output creates the real stream sink');
        assert.equal(f.ctx.turnStartedAt, clock);
        assert.equal(f.ctx.footerTimer, timer);
        assert.equal(f.ctx.streamState, 'responding');
        f.send({ type: 'agent_output', text: 'ANSWER-TWO', agentId: 'main' });
        assert.equal(f.ctx.streamSink, sink, 'subsequent chunks reuse the same sink');
        assert.equal(f.ctx.store.transcript.items.filter(item => item.type === 'assistant').length, 1);
        f.send({ type: 'agent_done', text: 'ANSWER-ONE\n\nANSWER-TWO' });
        assert.equal(f.output().split('ANSWER-ONE').length - 1, 1);
        assert.equal(f.output().split('ANSWER-TWO').length - 1, 1, 'end flushes the unfinished block exactly once');
        const thoughts = f.ctx.store.transcript.items.filter(item => item.type === 'thinking');
        assert.deepEqual(thoughts.map(item => item.text), ['PRESERVED-THOUGHT']);
        assert.equal(thoughts[0]?.streaming, false);
        assert.equal(answers[0]?.text, 'ANSWER-ONE\n\nANSWER-TWO');
        assert.equal(answers[0]?.streaming, false);
        f.assertIdle();
    } finally { f.dispose(); }
});

test('fresh line assistant control renders the same complete block and flushes once', t => {
    const f = fixture(t);
    try {
        f.send({ type: 'agent_output', text: 'ANSWER-ONE\n\n', agentId: 'main' });
        assert.ok(f.output().includes('ANSWER-ONE'), 'rules out a renderer safe-boundary problem');
        const sink = f.ctx.streamSink;
        assert.ok(sink);
        f.send({ type: 'agent_output', text: 'ANSWER-TWO', agentId: 'main' });
        assert.equal(f.ctx.streamSink, sink);
        f.send({ type: 'agent_done', text: 'ANSWER-ONE\n\nANSWER-TWO' });
        const answers = f.ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.equal(answers.length, 1);
        assert.equal(answers[0]?.text, 'ANSWER-ONE\n\nANSWER-TWO');
        assert.equal(f.output().split('ANSWER-TWO').length - 1, 1);
        f.assertIdle();
    } finally { f.dispose(); }
});

test('native final renders local Markdown once and discards the unfinished provisional sink', t => {
    const f = fixture(t);
    try {
        f.send({ type: 'agent_output', text: '**PROVISIONAL-ONLY**', agentId: 'main' });
        assert.ok(f.ctx.streamSink);
        const final = {
            type: 'agent_done', agentId: 'main', runtimeFinality: 'present', runtimeStatus: 'done',
            text: '**최종 답변** 👩‍💻 e\u0301\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        };
        f.send(final);
        assert.ok(f.output().includes('Final answer:'));
        assert.ok(f.output().includes('최종 답변 👩‍💻 e\u0301'));
        assert.ok(f.output().includes('A  B'));
        assert.ok(f.output().includes('1  2'));
        assert.ok(!f.output().includes('PROVISIONAL-ONLY'));
        assert.ok(!f.output().includes('**최종 답변**'));
        const answers = f.ctx.store.transcript.items.filter(item => item.type === 'assistant');
        assert.equal(answers.length, 1);
        assert.equal(answers[0]?.text, final.text);
        f.send(final);
        assert.equal(f.output().split('최종 답변').length - 1, 1);
        f.assertIdle();
    } finally { f.dispose(); }
});

test('fullscreen thinking -> assistant remains transcript/frame-only without a line sink', t => {
    const f = fixture(t, 'fullscreen');
    try {
        f.send({ type: 'agent_output', text: 'PRESERVED-THOUGHT', thinking: true, agentId: 'main' });
        const clock = f.ctx.turnStartedAt;
        const timer = f.ctx.footerTimer;
        const frames = f.frames();
        t.mock.timers.tick(600);
        f.send({ type: 'agent_output', text: 'FULLSCREEN-ANSWER', agentId: 'main' });
        assert.equal(f.ctx.streamSink, null);
        assert.equal(f.ctx.turnStartedAt, clock);
        assert.equal(f.ctx.footerTimer, timer);
        assert.ok(f.frames() > frames);
        f.send({ type: 'agent_done', text: 'FULLSCREEN-ANSWER' });
        assert.deepEqual(f.ctx.store.transcript.items.map(item => item.type), ['thinking', 'assistant']);
        assert.deepEqual(f.ctx.store.transcript.items.filter(item => item.type === 'thinking').map(item => item.text), ['PRESERVED-THOUGHT']);
        assert.equal(f.output(), '');
        f.assertIdle();
    } finally { f.dispose(); }
});

test('raw mode preserves original thinking/output/terminal records without assistant state', t => {
    const f = fixture(t, 'line', true);
    const logged: string[] = [];
    t.mock.method(console, 'log', (line: unknown) => { logged.push(String(line)); });
    try {
        const messages = [
            { type: 'agent_output', text: 'RAW-THOUGHT', thinking: true },
            { type: 'agent_output', text: 'RAW-ANSWER' },
            { type: 'agent_done', text: 'RAW-ANSWER' },
        ];
        for (const message of messages) f.send(message);
        assert.deepEqual(logged.slice(0, 3).map(line => JSON.parse(stripVTControlCharacters(line).trim())), messages);
        assert.equal(logged.length, 4, 'three raw records plus the existing prompt-block separator');
        assert.match(stripVTControlCharacters(logged[3]!).trim(), /^─+$/, 'existing line-mode terminal cleanup remains visible');
        assert.deepEqual(f.ctx.store.transcript.items, []);
        assert.equal(f.ctx.turnStartedAt, 0);
        f.assertIdle();
    } finally { f.dispose(); }
});

test('line running tool renders pending, completion updates one row, and terminal stops spinner/timer', t => {
    const f = fixture(t);
    try {
        f.send({ type: 'agent_status', status: 'running', agentId: 'main' });
        assert.equal(isSpinning(), true);
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'fixture-only', status: 'running', stepRef: 's1' });
        assert.ok(f.output().includes('⏳ Bash: fixture-only'));
        let tools = f.ctx.store.transcript.items.filter(item => item.type === 'tool');
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.status, 'running');
        assert.equal(tools[0]?.collapsed, false);
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: '', status: 'done', stepRef: 's1' });
        assert.ok(f.output().includes('✔ Bash'));
        tools = f.ctx.store.transcript.items.filter(item => item.type === 'tool');
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.status, 'done');
        assert.equal(tools[0]?.detail, 'fixture-only');
        assert.equal(tools[0]?.collapsed, true);
        f.send({ type: 'agent_done', text: '' });
        f.assertIdle();
    } finally { f.dispose(); }
});

test('fullscreen running tool stays live until one terminal commit', t => {
    const f = fixture(t, 'fullscreen');
    try {
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'first', status: 'running', stepRef: 's1' });
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'latest', status: 'running', stepRef: 's1' });
        assert.equal(f.ctx.store.transcript.items.length, 0);
        assert.equal(f.ctx.store.transcript.liveTools.length, 1);
        assert.equal(f.ctx.store.transcript.liveTools[0]?.detail, 'latest');
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: '', status: 'done', stepRef: 's1' });
        f.send({ type: 'agent_tool', icon: '🔧', label: 'Bash', detail: 'duplicate', status: 'done', stepRef: 's1' });
        const tools = f.ctx.store.transcript.items.filter(item => item.type === 'tool');
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.status, 'done');
        assert.equal(tools[0]?.detail, 'latest');
        assert.equal(f.ctx.store.transcript.liveTools.length, 0);
        f.send({ type: 'agent_done', text: '' });
        assert.equal(f.output(), '');
        f.assertIdle();
    } finally { f.dispose(); }
});
