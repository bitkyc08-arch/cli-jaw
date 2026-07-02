/**
 * cli-jaw chat — Phase 9.5
 * Three modes: default (raw stdin, persistent footer), --raw (JSON in UI), --simple (plain readline)
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadLocales } from '../../src/core/i18n.js';
import { consumePasteProtocol, getComposerDisplayText, setBracketedPaste } from '../../src/cli/tui/composer.js';
import { cleanupScrollRegion, resolveShellLayout, setupScrollRegion } from '../../src/cli/tui/shell.js';
import { createTuiStore } from '../../src/cli/tui/store.js';
import { isGitRepo, detectIde } from '../../src/ide/diff.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw chat — interactive terminal REPL

  Usage: jaw chat [--port <3457>] [--<port>] [--raw] [--simple]

  Connects to the running jaw server for interactive chat.
  Server must be running first (jaw serve).

  Modes:
    (default)    Rich TUI with persistent footer
    --raw        JSON protocol mode (for UI integration)
    --simple     Plain readline (minimal)

  Options:
    --port <N>   Server port (default: 3457)
    --<N>        Port shorthand (e.g. --3458)
    --theme <name>  TUI color theme: dark | light (default: dark, or settings tui.theme)
    --fullscreen    Alt-screen TUI (default for TTY terminals)
    --classic       Force line-mode TUI (opt-out from fullscreen)
`);
import { APP_VERSION, getServerUrl, getWsUrl } from '../../src/core/config.js';
import { c, cliColor, cliLabel, hrLine, getRows, ESC_WAIT_MS, formatFooter, type TuiContext } from './tui/types.js';
import { splitKeyInput } from '../../src/cli/tui/keymap.js';
import { runSimpleMode } from './tui/simple-mode.js';
import { initHighlight } from '../../src/cli/tui/highlight.js';
import { openPromptBlock } from './tui/renderer.js';
import { redrawInputWithAutocomplete, handleResize } from './tui/overlays.js';
import { handleKeyInput, flushPendingEscape } from './tui/input-handler.js';
import { runFullscreenMode } from './tui/fullscreen-mode.js';
import { resolveTuiDisplayMode } from '../../src/cli/tui/mode.js';
import { handleWsMessage } from './tui/ws-handler.js';
import { connectChannel, type ChatChannel } from './tui/channel.js';
import { asRecord, fieldString } from '../_http-client.js';

// ─── Init ────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_SCRIPT = resolvePath(__dirname, 'skill.js');

function findPackageRoot(start: string): string {
    let dir = start;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(join(dir, 'public', 'locales'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolvePath(start, '../..');
}
loadLocales(join(findPackageRoot(__dirname), 'public', 'locales'));

// --NNNN shorthand → --port NNNN (e.g. jaw chat --3458)
const rawArgs = process.argv.slice(3);
const args: string[] = [];
for (const arg of rawArgs) {
    const m = /^--(\d{2,5})$/.exec(arg);
    if (m) { args.push('--port', m[1]!); }
    else { args.push(arg); }
}

const { values } = parseArgs({
    args,
    options: {
        port: { type: 'string', default: process.env["PORT"] || '3457' },
        raw: { type: 'boolean', default: false },
        simple: { type: 'boolean', default: false },
        theme: { type: 'string' },
        fullscreen: { type: 'boolean', default: false },
        classic: { type: 'boolean', default: false },
    },
    strict: false,
});

// ─── Connect (SSE first, legacy WS fallback — X-01) ──
const wsUrl = getWsUrl(values.port as string);
const apiUrl = getServerUrl(values.port as string);

let ws: ChatChannel;
try {
    ws = await connectChannel(values.port as string);
} catch {
    console.error(`\n  ${c.red}x${c.reset} Cannot connect to ${apiUrl}/api/events or ${wsUrl}`);
    console.error(`  Run ${c.cyan}cli-jaw serve${c.reset} first\n`);
    process.exit(1);
}

// ─── Fetch info ──────────────────────────────
let info = { cli: 'codex', workingDir: '~', model: '' };
let runtimeLocale = 'ko';
let tuiConfig = { pasteCollapseLines: 2, pasteCollapseChars: 160, keymapPreset: 'default', diffStyle: 'summary', themeSeed: 'jaw-default' };
let settingsSnapshot: Record<string, unknown> = {};
try {
    const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
        const res = asRecord(await r.json());
        const s = asRecord(res["data"] || res);
        const cli = fieldString(s["cli"], 'codex');
        const perCli = asRecord(s["perCli"]);
        const cliSettings = asRecord(perCli[cli]);
        settingsSnapshot = s;
        info = { cli, workingDir: fieldString(s["workingDir"], '~'), model: fieldString(cliSettings["model"]) };
        if (typeof s["locale"] === 'string') runtimeLocale = s["locale"];
        if (s["tui"] && typeof s["tui"] === 'object') tuiConfig = { ...tuiConfig, ...asRecord(s["tui"]) };
    }
    const sr = await fetch(`${apiUrl}/api/session`, { signal: AbortSignal.timeout(2000) });
    if (sr.ok) {
        const ses = asRecord(await sr.json());
        const sd = asRecord(ses["data"] || ses);
        if (typeof sd["model"] === 'string') info.model = sd["model"];
    }
} catch { /* keep defaults */ }

function firstProjectRoot(settings: Record<string, unknown>): string | undefined {
    const dirs = settings["projectDirs"];
    if (!Array.isArray(dirs)) return undefined;
    const first = dirs.find((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0);
    return first ? resolvePath(first) : undefined;
}

function resolveChatCwd(settings: Record<string, unknown>, fallbackWorkingDir: string): string {
    const projectRoot = firstProjectRoot(settings);
    if (projectRoot) return projectRoot;
    if (fallbackWorkingDir && fallbackWorkingDir !== '~') {
        return fallbackWorkingDir.startsWith('~')
            ? join(homedir(), fallbackWorkingDir.slice(1))
            : resolvePath(fallbackWorkingDir);
    }
    return process.cwd();
}

const themeFromSettings = typeof (tuiConfig as Record<string, unknown>)['theme'] === 'string'
    ? (tuiConfig as Record<string, unknown>)['theme'] as string
    : undefined;
const themeArg = typeof values.theme === 'string' ? values.theme : undefined;
const resolvedTheme = themeArg || themeFromSettings || 'dark';
if (resolvedTheme === 'light' || resolvedTheme === 'dark') {
    process.env['JAW_TUI_THEME'] = resolvedTheme;
}

const displayMode = resolveTuiDisplayMode({
    fullscreenFlag: values.fullscreen ? true : undefined,
    classicFlag: values.classic ? true : undefined,
    settingsFullscreen: (tuiConfig as Record<string, unknown>)['fullscreen'] as boolean | undefined,
});

const initialProjectRoot = firstProjectRoot(settingsSnapshot);
const chatCwd = resolveChatCwd(settingsSnapshot, info.workingDir);
const isGit = isGitRepo(chatCwd);
let gitBranch = '';
if (isGit) {
    try { gitBranch = spawnSync('git', ['branch', '--show-current'], { cwd: chatCwd, encoding: 'utf8' }).stdout?.trim() || ''; } catch {}
}
const detectedIde = detectIde();

// ─── Build TuiContext ────────────────────────
const ctx: TuiContext = {
    ws, apiUrl,
    info,
    accent: cliColor[info.cli] || c.red,
    label: cliLabel[info.cli] || info.cli,
    dir: info.workingDir.replace(homedir(), '~'),
    runtimeLocale,
    tuiConfig,
    settingsSnapshot,
    values: { port: values.port as string, raw: !!values.raw, simple: !!values.simple },
    isRaw: !!values.raw,
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
    ideEnabled: isGit,
    idePopEnabled: false,
    preFileSetQueue: [],
    ...(initialProjectRoot ? { projectRoot: initialProjectRoot } : {}),
    chatCwd,
    isGit,
    gitBranch,
    detectedIde,
    promptPrefix: '',
    footer: '',
    displayMode,
    requestFrame: null,
};
ctx.footer = formatFooter(ctx.label, ctx.accent, 'idle');
ctx.promptPrefix = `  ${ctx.accent}\u276F${c.reset} `;

// ─── Mode branch ─────────────────────────────
if (values.simple) {
    await runSimpleMode(ctx);
} else {
    if (!ctx.isRaw) await initHighlight();   // interactive rich TUI only; --simple & --raw untouched
    // Initialize jawcode TUI components (async, once)
    const { tryInitJawcodeTui } = await import('../../src/cli/tui/jawcode-render.js');
    const { renderWelcome } = await import('../../src/cli/tui/jawcode-bridge.js');
    await tryInitJawcodeTui();
    const welcomeOpts = {
        version: APP_VERSION,
        engine: ctx.label,
        engineAccent: ctx.accent,
        model: info.model || 'default',
        directory: ctx.dir,
        serverPort: Number(values.port),
        gitBranch: gitBranch || undefined,
        projectRoot: ctx.projectRoot,
        port: ctx.serverPort,
    };

    const welcomeLines = renderWelcome(welcomeOpts);

    if (displayMode === 'fullscreen') {
        ctx.welcomeLines = welcomeLines;
        await runFullscreenMode(ctx);
    } else {
        console.log('');
        for (const line of welcomeLines) console.log(line);
        console.log('');

    // ─── Raw stdin ───────────────────────────
    process.stdin.setRawMode(true);
    setBracketedPaste(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdout.on('resize', () => {
        if (ctx.resizeTimer) clearTimeout(ctx.resizeTimer);
        ctx.resizeTimer = setTimeout(() => { ctx.resizeTimer = null; handleResize(ctx); }, 50);
    });

    process.stdin.on('data', (_key) => {
        let incoming = _key as unknown as string;
        if (ctx.escPending) {
            if (ctx.escTimer) clearTimeout(ctx.escTimer);
            ctx.escTimer = null;
            ctx.escPending = false;
            if (!incoming.startsWith('\x1b')) incoming = `\x1b${incoming}`;
        }
        if (incoming === '\x1b') {
            ctx.escPending = true;
            ctx.escTimer = setTimeout(() => flushPendingEscape(ctx), ESC_WAIT_MS);
            return;
        }
        if (ctx.commandRunning && !ctx.inputActive) return;
        const composer = ctx.store.composer;
        const beforeDisplay = getComposerDisplayText(composer);
        const tokens = consumePasteProtocol(incoming, ctx.store.pasteCapture, composer, {
            collapseLines: ctx.tuiConfig.pasteCollapseLines,
            collapseChars: ctx.tuiConfig.pasteCollapseChars,
        });
        const afterDisplay = getComposerDisplayText(composer);
        if (beforeDisplay !== afterDisplay) {
            if (!ctx.inputActive) {
                if (ctx.commandRunning) return;
                ctx.inputActive = true;
                openPromptBlock(ctx);
            }
            redrawInputWithAutocomplete(ctx);
            if (tokens.length === 0) return;
        }
        for (const token of tokens.flatMap(splitKeyInput)) handleKeyInput(ctx, token);
    });

    // ─── Channel messages (SSE or legacy WS) ─
    ws.on('message', (data) => handleWsMessage(ctx, data));

    ws.on('close', () => {
        cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes));
        console.log(`\n  ${c.dim}Disconnected${c.reset}\n`);
        setBracketedPaste(false);
        process.stdin.setRawMode(false);
        process.exit(0);
    });

    setupScrollRegion(ctx.footer, `  ${c.dim}${hrLine()}${c.reset}`, resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes));
    openPromptBlock(ctx);
    }
}

// ─── Utilities (kept for external use) ───────
export function runSkillResetLocal() {
    const proc = spawnSync(
        process.execPath,
        [SKILL_SCRIPT, 'reset', '--force'],
        { encoding: 'utf8', timeout: 120000 },
    );
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
        const msg = (proc.stderr || proc.stdout || `exit ${proc.status}`).trim();
        throw new Error(msg);
    }
}
