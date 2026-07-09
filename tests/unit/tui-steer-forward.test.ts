// ─── TUI /steer forwarding (260703 tui_steer_esc_rca doc 10) ─────────────
// /steer is excluded from the 'cli' interface on purpose (STR-001: the agent
// lives in the server process). The TUI must therefore FORWARD the raw
// "/steer <prompt>" text to POST /api/message instead of executing the
// handler locally, and reflect the server's feedback text in the transcript.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runSlashCommand } from '../../bin/commands/tui/slash-command-runner.ts';
import { parseCommand } from '../../src/cli/commands.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';

function makeCtx(apiUrl: string): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl,
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160, keymapPreset: 'default', diffStyle: 'summary' },
        settingsSnapshot: {},
        values: { port: '3457', raw: false, simple: false },
        isRaw: false,
        store: createTuiStore(),
        overlayBoxHeight: 0,
        inputActive: false,
        streaming: true,
        streamState: 'responding',
        bgtaskCount: 0,
        bgtaskTasks: [],
        turnStartedAt: 0,
        streamSink: null,
        commandRunning: true,
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

function startServer(
    handler: (body: { prompt?: string }) => { status?: number; json: unknown },
    received: Array<{ path: string; prompt?: string }>,
): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                const body = raw ? JSON.parse(raw) as { prompt?: string } : {};
                received.push({ path: req.url || '', ...(body.prompt !== undefined ? { prompt: body.prompt } : {}) });
                const out = handler(body);
                res.writeHead(out.status || 200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(out.json));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

test('/steer forwards the raw command text to POST /api/message and arms stream state', async () => {
    const received: Array<{ path: string; prompt?: string }> = [];
    const { server, url } = await startServer(
        () => ({ json: { ok: true, command: true, type: 'success', text: 'Steering agent…' } }),
        received,
    );
    try {
        const ctx = makeCtx(url);
        await runSlashCommand(ctx, parseCommand('/steer focus on the failing test'));

        assert.deepEqual(received, [{ path: '/api/message', prompt: '/steer focus on the failing test' }]);
        assert.equal(ctx.commandRunning, false);
        // Steered turn is starting — composer must stay in streaming mode so
        // ESC-stop remains armed.
        assert.equal(ctx.inputActive, false);
        const last = ctx.store.transcript.items.at(-1);
        assert.equal(last?.type, 'command');
        if (last?.type === 'command') {
            assert.equal(last.commandName, 'steer');
            assert.equal(last.ok, true);
            assert.match(last.text, /Steering/);
        }
    } finally {
        server.close();
    }
});

test('/steer with no prompt shows usage locally without calling the server', async () => {
    const received: Array<{ path: string; prompt?: string }> = [];
    const { server, url } = await startServer(() => ({ json: { ok: true } }), received);
    try {
        const ctx = makeCtx(url);
        await runSlashCommand(ctx, parseCommand('/steer'));

        assert.deepEqual(received, []);
        assert.equal(ctx.commandRunning, false);
        assert.equal(ctx.inputActive, true);
        const last = ctx.store.transcript.items.at(-1);
        assert.equal(last?.type, 'command');
        if (last?.type === 'command') assert.equal(last.ok, false);
    } finally {
        server.close();
    }
});

test('/steer surfaces a server-side rejection (e.g. no active agent) and restores input', async () => {
    const received: Array<{ path: string; prompt?: string }> = [];
    const { server, url } = await startServer(
        () => ({ json: { ok: false, command: true, type: 'error', text: 'no agent running' } }),
        received,
    );
    try {
        const ctx = makeCtx(url);
        await runSlashCommand(ctx, parseCommand('/steer do something'));

        assert.equal(received.length, 1);
        assert.equal(ctx.commandRunning, false);
        assert.equal(ctx.inputActive, true);
        const last = ctx.store.transcript.items.at(-1);
        assert.equal(last?.type, 'command');
        if (last?.type === 'command') {
            assert.equal(last.ok, false);
            assert.match(last.text, /no agent running/);
        }
    } finally {
        server.close();
    }
});
