/**
 * TUI shared types, constants, and helpers.
 */
import type { TuiStore } from '../../../src/cli/tui/store.js';
import type { StreamSink } from '../../../src/cli/tui/stream.js';
import type { IdeType } from '../../../src/ide/diff.js';
import type { ChatChannel } from './channel.js';

// ─── ANSI color codes ────────────────────────
export const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

export const cliLabel: Record<string, string> = {
    agy: 'Antigravity',
    'ai-e': 'AI-E',
    claude: 'Claude Code',
    'claude-e': 'Claude E',
    codex: 'Codex',
    'codex-app': 'Codex App',
    cursor: 'Cursor',
    'kiro-code': 'Kiro',
    gemini: 'Gemini CLI',
    grok: 'Grok',
    opencode: 'OpenCode',
    copilot: 'Copilot',
    pi: 'Pi',
};
export const cliColor: Record<string, string> = {
    agy: c.green,
    'ai-e': c.green,
    claude: c.magenta,
    'claude-e': c.magenta,
    codex: c.red,
    'codex-app': c.red,
    cursor: c.cyan,
    'kiro-code': c.magenta,
    gemini: c.blue,
    grok: c.gray,
    opencode: c.yellow,
    copilot: c.cyan,
    pi: c.yellow,
};

export const ESC_WAIT_MS = 70;

// ─── Terminal dimension helpers ──────────────
export const W = () => Math.max(20, Math.min((process.stdout.columns || 60) - 4, 60));
export const hrLine = () => `${c.dim}${'─'.repeat(W())}${c.reset}`;
export const getRows = () => process.stdout.rows || 24;

export function renderCommandText(text: string) {
    return String(text || '').replace(/\n/g, '\n  ');
}

export function renderError(msg: string): string {
    return `  ${c.red}✖${c.reset} ${c.bold}${msg}${c.reset}`;
}

/** Footer string with a live state segment. Pure — used by rebuildFooter. */
export function formatFooter(
    label: string,
    accent: string,
    state: 'idle' | 'responding' | 'tool',
    elapsedMs?: number,
    bgtaskCount?: number,
): string {
    const stateLabel = state === 'responding' ? 'responding…' : state === 'tool' ? 'working…' : 'idle';
    const stateColored = state === 'idle' ? `${c.dim}${stateLabel}${c.reset}` : `${accent}${stateLabel}${c.reset}`;
    const elapsed = elapsedMs && elapsedMs > 0 ? `  ${c.dim}${(elapsedMs / 1000).toFixed(1)}s${c.reset}` : '';
    // Server-owned background tasks (bgtask) — magenta to stay distinct from the queue.
    const bgtask = bgtaskCount && bgtaskCount > 0 ? `  ${c.magenta}\u23F3${bgtaskCount}${c.reset}` : '';
    const sep = `${c.dim} │ ${c.reset}`;
    return `  ${accent}${c.bold}${label}${c.reset}${sep}${stateColored}${elapsed}${bgtask}${sep}${c.dim}/quit  /clear${c.reset}`;
}

/** Enhanced footer with model + path segments. */
export function formatFooterFull(
    label: string,
    accent: string,
    state: 'idle' | 'responding' | 'tool',
    opts: { elapsedMs?: number | undefined; bgtaskCount?: number | undefined; model?: string | undefined; cwd?: string | undefined },
): string {
    const stateLabel = state === 'responding' ? 'responding…' : state === 'tool' ? 'working…' : 'idle';
    const stateColored = state === 'idle' ? `${c.dim}${stateLabel}${c.reset}` : `${accent}${stateLabel}${c.reset}`;
    const elapsed = opts.elapsedMs && opts.elapsedMs > 0 ? ` ${c.dim}${(opts.elapsedMs / 1000).toFixed(1)}s${c.reset}` : '';
    const bgtask = opts.bgtaskCount && opts.bgtaskCount > 0 ? ` ${c.magenta}⏳${opts.bgtaskCount}${c.reset}` : '';
    const sep = `${c.dim} │ ${c.reset}`;
    const modelSeg = opts.model ? `${c.cyan}${opts.model}${c.reset} ` : '';
    const pathSeg = opts.cwd ? `${sep}${c.dim}📁 ${opts.cwd.replace(process.env['HOME'] || '', '~')}${c.reset}` : '';
    return `  ${modelSeg}${accent}${c.bold}${label}${c.reset}${sep}${stateColored}${elapsed}${bgtask}${pathSeg}${sep}${c.dim}/quit  /clear${c.reset}`;
}

// ─── Shared state interface ──────────────────
export interface TuiContext {
    ws: ChatChannel;
    apiUrl: string;

    info: { cli: string; workingDir: string; model: string };
    accent: string;
    label: string;
    dir: string;
    runtimeLocale: string;
    tuiConfig: { pasteCollapseLines: number; pasteCollapseChars: number; [k: string]: unknown };
    settingsSnapshot: Record<string, unknown>;
    values: { port: string; raw: boolean; simple: boolean };
    isRaw: boolean;

    store: TuiStore;

    overlayBoxHeight: number;
    inputActive: boolean;
    streaming: boolean;
    streamState: 'idle' | 'responding' | 'tool';
    bgtaskCount: number;
    bgtaskTasks: Array<{ id: string; kind: string; startedAt: string | null }>;
    turnStartedAt: number;
    streamSink: StreamSink | null;
    commandRunning: boolean;
    escPending: boolean;
    escTimer: ReturnType<typeof setTimeout> | null;
    footerTimer: ReturnType<typeof setInterval> | null;
    editorChordPending: boolean;
    prevLineCount: number;
    promptCursorRow: number;
    resizeTimer: ReturnType<typeof setTimeout> | null;

    ideEnabled: boolean;
    idePopEnabled: boolean;
    preFileSetQueue: Map<string, string>[];
    chatCwd: string;
    isGit: boolean;
    gitBranch?: string;
    orchPhase?: string;
    projectRoot?: string;
    serverPort?: number;
    detectedIde: IdeType;

    promptPrefix: string;
    footer: string;
    displayMode: 'line' | 'fullscreen';
    requestFrame: (() => void) | null;
    welcomeLines?: string[];
}
