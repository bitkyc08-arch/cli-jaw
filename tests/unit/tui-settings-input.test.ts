import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyInput } from '../../bin/commands/tui/input-handler.ts';
import { applySettingsSelection } from '../../bin/commands/tui/overlays.ts';
import { createTuiStore } from '../../src/cli/tui/store.ts';
import { getComposerDisplayText } from '../../src/cli/tui/composer.ts';
import type { TuiContext } from '../../bin/commands/tui/types.ts';
import { buildAppearanceRows } from '../../src/cli/tui/settings-screen.ts';

function makeCtx(): TuiContext {
    return {
        ws: { send() { /* no-op */ }, close() { /* no-op */ } },
        apiUrl: 'http://127.0.0.1:3457',
        info: { cli: 'codex', workingDir: '/tmp/project', model: 'test-model' },
        accent: '',
        label: 'codex',
        dir: '/tmp/project',
        runtimeLocale: 'en',
        tuiConfig: { theme: 'dark', fullscreen: true, pasteCollapseLines: 2, pasteCollapseChars: 160 },
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

test('settings key handling moves selection and ignores composer text', () => {
    const ctx = makeCtx();
    ctx.store.overlay.settingsOpen = true;
    let frames = 0;
    ctx.requestFrame = () => { frames += 1; };

    handleKeyInput(ctx, '\x1b[B');
    assert.equal(ctx.store.overlay.settingsSelected, 1);
    assert.equal(frames, 1);

    handleKeyInput(ctx, 'a');
    assert.equal(getComposerDisplayText(ctx.store.composer), '');
    assert.equal(ctx.store.overlay.settingsSelected, 1);
});

test('applySettingsSelection saves editable rows and reports read-only rows', async () => {
    const ctx = makeCtx();
    ctx.store.overlay.settingsOpen = true;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/api/auth/token')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
        if (String(url).endsWith('/api/session')) return new Response(JSON.stringify({ data: { model: 'test-model' } }), { status: 200 });
        if (String(url).endsWith('/api/settings')) {
            if (init?.method === 'PUT') {
                return new Response(JSON.stringify({ data: { showReasoning: false, tui: { theme: 'light', fullscreen: true } } }), { status: 200 });
            }
            return new Response(JSON.stringify({ data: { showReasoning: false, tui: { theme: 'light', fullscreen: true } } }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
        await applySettingsSelection(ctx);
        const put = calls.find(call => call.init?.method === 'PUT');
        assert.ok(put);
        assert.equal(put.init?.body, JSON.stringify({ tui: { theme: 'light' } }));
        assert.equal(ctx.tuiConfig.theme, 'light');
        assert.equal(process.env['JAW_TUI_THEME'], 'light');
        assert.match(ctx.store.overlay.settingsMessage, /Saved Theme/);

        ctx.store.overlay.settingsSelected = buildAppearanceRows({ settings: ctx.settingsSnapshot,
            tuiConfig: ctx.tuiConfig, footerPreview: ctx.footer }).findIndex(row => row.id === 'markdownRenderer');
        await applySettingsSelection(ctx);
        assert.match(ctx.store.overlay.settingsMessage, /read-only/);
        assert.equal(calls.filter(call => call.init?.method === 'PUT').length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
