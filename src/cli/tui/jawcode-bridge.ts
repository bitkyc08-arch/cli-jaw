/**
 * jawcode Component bridge — uses actual jawcode InteractiveMode components.
 * Replaces the old ANSI hardcoding adapter with real Component.render() calls.
 */
import { initJawcodeTui, isInitialized, getInteractive, renderMarkdownJawcode } from './jawcode-render.js';
import { renderJawWelcome } from './welcome-jaw.js';

export interface JawcodeAdapterState {
    initialized: boolean;
    welcomeRendered: boolean;
    currentAssistant: string | null;
    toolStates: Map<string, 'pending' | 'done' | 'error'>;
}

export function createAdapterState(): JawcodeAdapterState {
    return {
        initialized: false,
        welcomeRendered: false,
        currentAssistant: null,
        toolStates: new Map(),
    };
}

export async function ensureInitialized(state: JawcodeAdapterState): Promise<void> {
    if (state.initialized) return;
    await initJawcodeTui();
    state.initialized = true;
}

export function renderWelcome(opts: {
    version: string;
    engine: string;
    engineAccent: string;
    model: string;
    directory: string;
    serverPort: number;
    ideDiff?: string | undefined;
    gitBranch?: string | undefined;
    projectRoot?: string | undefined;
    port?: number | undefined;
    recentSessions?: Array<{ label: string; ago: string }> | undefined;
}): string[] {
    return renderJawWelcome({
        version: opts.version,
        model: opts.model,
        engine: opts.engine,
        projectRoot: opts.projectRoot ?? opts.directory,
        port: opts.port ?? opts.serverPort,
        gitBranch: opts.gitBranch,
        recentSessions: opts.recentSessions,
    }, process.stdout.columns || 80);
}

export function renderAssistantChunk(text: string, width: number): string[] {
    if (!isInitialized()) return [text];
    return renderMarkdownJawcode(text, width);
}

function getTheme(): { fg: (color: string, text: string) => string; bold: (text: string) => string; italic: (text: string) => string } | null {
    if (!isInitialized()) return null;
    try { return getInteractive().theme; } catch { return null; }
}

export function renderToolLine(_icon: string, label: string, detail: string, state: 'pending' | 'done' | 'error', opts?: { depth?: number; isLast?: boolean; elapsed?: string }): string {
    const theme = getTheme();
    const detailLines = detail.split('\n').map(line => line.trim()).filter(Boolean);
    const firstDetail = detailLines[0] ?? '';
    const foldedHint = detailLines.length > 1
        ? `: ${firstDetail} … +${detailLines.length - 1} lines`
        : firstDetail ? `: ${firstDetail}` : '';
    if (!theme) {
        const stateIcon = state === 'done' ? '\x1b[32m✔\x1b[0m' : state === 'error' ? '\x1b[31m✖\x1b[0m' : '\x1b[36m⏳\x1b[0m';
        const detailText = state === 'pending' || state === 'error'
            ? (detail ? `: ${detail}` : '')
            : foldedHint;
        return `  ${stateIcon} ${label}${detailText}`;
    }
    const stateIcon = state === 'done' ? theme.fg('success', '✔') : state === 'error' ? theme.fg('error', '✖') : theme.fg('accent', '⏳');
    const depth = opts?.depth || 0;
    const treePre = depth > 0 ? `${'  '.repeat(depth - 1)}${opts?.isLast ? '└─ ' : '├─ '}` : '';
    const elapsedStr = opts?.elapsed ? ` ${theme.fg('muted', opts.elapsed)}` : '';
    const collapsedHint = state === 'done' && foldedHint ? theme.fg('muted', foldedHint) : '';
    return `  ${treePre}${stateIcon} ${theme.bold(label)}${detail && state !== 'done' ? theme.fg('muted', `: ${detail}`) : collapsedHint}${elapsedStr}`;
}

/**
 * Multi-line tool block for fullscreen transcript rendering.
 * Returns an array of rows: header + optional detail preview.
 */
export function renderToolBlock(label: string, detail: string, state: 'pending' | 'done' | 'error', opts?: {
    collapsed?: boolean | undefined;
    width?: number | undefined;
}): string[] {
    const theme = getTheme();
    const width = opts?.width ?? (process.stdout.columns || 80);
    const detailLines = detail.split('\n').map(line => line.trim()).filter(Boolean);
    const expanded = opts?.collapsed === false;

    // Header line
    const headerLine = renderToolLine('', label, expanded ? '' : detail, state);
    const rows: string[] = [headerLine];

    // Detail block — show when expanded (collapsed === false) and there are detail lines
    if (expanded && detailLines.length > 0) {
        const prefix = theme ? `  ${theme.fg('muted', '│')} ` : '  \x1b[2m│\x1b[0m ';
        const detailWidth = Math.max(10, width - 6);
        const maxRows = 14;
        for (let i = 0; i < Math.min(detailLines.length, maxRows); i++) {
            const line = detailLines[i]!;
            const clipped = line.length > detailWidth ? line.slice(0, detailWidth - 1) + '…' : line;
            rows.push(`${prefix}${theme ? theme.fg('muted', clipped) : `\x1b[2m${clipped}\x1b[0m`}`);
        }
        if (detailLines.length > maxRows) {
            rows.push(`${prefix}${theme ? theme.fg('muted', `… +${detailLines.length - maxRows} lines`) : `\x1b[2m… +${detailLines.length - maxRows} lines\x1b[0m`}`);
        }
    }

    return rows;
}


export function renderThinkingCollapse(text: string, lineCount: number, expanded: boolean): string {
    const theme = getTheme();
    if (!theme) return `  \x1b[3m\x1b[2m${expanded ? text : `Thinking … +${lineCount} lines`}\x1b[0m`;
    if (expanded) return `  ${theme.fg('muted', theme.italic(text))}`;
    return `  ${theme.fg('muted', theme.italic(`Thinking … +${lineCount} lines`))}`;
}

export function renderSubagentTree(agents: Array<{
    name: string;
    status: string;
    elapsed?: string;
    model?: string;
    description?: string;
    children?: Array<{ label: string; detail?: string }>;
}>): string[] {
    const theme = getTheme();
    if (!theme) return [];
    const lines: string[] = [];
    for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!;
        const isLast = i === agents.length - 1;
        const pre = isLast ? '└─' : '├─';
        const stIcon = a.status === 'completed' ? theme.fg('success', '✔') : a.status === 'running' ? theme.fg('accent', '⏳') : theme.fg('warning', '①');
        lines.push(`  ${pre} ${stIcon} ${theme.bold(a.name)}${a.elapsed ? ` ${theme.fg('muted', a.elapsed)}` : ''}`);
        if (a.description) lines.push(`  ${isLast ? '   ' : '│  '}${theme.fg('muted', `Description: ${a.description}`)}`);
        if (a.model) lines.push(`  ${isLast ? '   ' : '│  '}${theme.fg('muted', `Agent: ${a.model}`)}`);
        if (a.children) {
            for (let j = 0; j < a.children.length; j++) {
                const ch = a.children[j]!;
                const chPre = j === a.children.length - 1 ? '└─' : '├─';
                lines.push(`  ${isLast ? '   ' : '│  '}${chPre} ${theme.fg('muted', `${ch.label}${ch.detail ? `: ${ch.detail}` : ''}`)}`);
            }
        }
    }
    return lines;
}

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function cellWidthOfCodePoint(cp: number): number {
    if ((cp >= 0x0300 && cp <= 0x036F) || (cp >= 0xFE00 && cp <= 0xFE0F)) {
        return 0;
    }
    return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xD7FF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) || cp === 0x23F3 || cp === 0x231B ||
        (cp >= 0x1F000 && cp <= 0x1FFFF) ||
        (cp >= 0x20000 && cp <= 0x2FA1F) || (cp >= 0xF0000 && cp <= 0xFFFFD) ? 2 : 1;
}

function widthOf(text: string): number {
    let width = 0;
    for (const ch of stripAnsi(text)) {
        width += cellWidthOfCodePoint(ch.codePointAt(0) ?? 0);
    }
    return width;
}

function clipAnsiSafe(text: string, cols: number): string {
    if (cols <= 0) return '';
    let out = '';
    let width = 0;
    let pos = 0;
    while (pos < text.length) {
        if (text.charCodeAt(pos) === 0x1b && pos + 1 < text.length && text[pos + 1] === '[') {
            const start = pos;
            pos += 2;
            while (pos < text.length && !(text.charCodeAt(pos) >= 0x40 && text.charCodeAt(pos) <= 0x7e)) pos++;
            if (pos < text.length) pos++;
            out += text.slice(start, pos);
            continue;
        }
        const code = text.codePointAt(pos);
        if (code === undefined) break;
        const ch = String.fromCodePoint(code);
        const cw = cellWidthOfCodePoint(code);
        if (width + cw > cols) break;
        out += ch;
        width += cw;
        pos += ch.length;
    }
    return out;
}

function renderSegment(text: string): string {
    return `\x1b[46m\x1b[30m ${text} \x1b[0m`;
}

function renderSegmentedStatusLine(left: string, right: string, cols: number, opts?: { railColor?: string }): string {
    const prefix = '  ';
    const safeCols = Math.max(20, cols);
    const rightBudget = Math.max(8, Math.min(Math.floor(safeCols * 0.35), safeCols - 10));
    const clippedRight = clipAnsiSafe(right, rightBudget);
    const rightSeg = renderSegment(clippedRight);
    const leftBudget = Math.max(1, safeCols - widthOf(prefix) - widthOf(rightSeg) - 1);
    const leftSeg = renderSegment(clipAnsiSafe(left, leftBudget));
    const railWidth = Math.max(0, safeCols - widthOf(prefix) - widthOf(leftSeg) - widthOf(rightSeg));
    const railColor = opts?.railColor ?? '\x1b[36m';
    const rail = `${railColor}${'─'.repeat(railWidth)}\x1b[0m`;
    return `${prefix}${leftSeg}${rail}${rightSeg}`;
}

export function renderStatusBar(segments: {
    model?: string;
    engine: string;
    engineAccent: string;
    state: string;
    elapsed?: string | undefined;
    bgtask?: number | undefined;
    gitBranch?: string | undefined;
    cwd?: string | undefined;
    port?: number | undefined;
    orchPhase?: string | undefined;
}): string {
    const theme = getTheme();
    const icon = (() => { try { const { sharkIcon } = require('./icons.js'); return sharkIcon(); } catch { return '🦈'; } })();
    const parts: string[] = [];
    const cols = process.stdout.columns || 80;
    const style = {
        accent: (text: string) => theme ? theme.fg('accent', text) : `\x1b[36m${text}\x1b[0m`,
        muted: (text: string) => theme ? theme.fg('muted', text) : `\x1b[2m${text}\x1b[0m`,
        warning: (text: string) => theme ? theme.fg('warning', text) : `\x1b[33m${text}\x1b[0m`,
        bold: (text: string) => theme ? theme.bold(text) : `\x1b[1m${text}\x1b[0m`,
    };
    if (segments.model) parts.push(style.accent(segments.model));
    parts.push(`${segments.engineAccent}${style.bold(`${icon} ${segments.engine}`)}`);
    parts.push(segments.state === 'idle' ? style.muted(segments.state) : style.accent(segments.state));
    if (segments.elapsed) parts.push(style.muted(segments.elapsed));
    if (segments.bgtask && segments.bgtask > 0) parts.push(style.warning(`⏳${segments.bgtask}`));
    if (segments.orchPhase) parts.push(style.accent(`📋${segments.orchPhase.toUpperCase()}`));
    if (segments.gitBranch) parts.push(style.muted(`ⴲ ${segments.gitBranch}`));
    if (segments.cwd) parts.push(style.muted(`📁 ${segments.cwd}`));
    while (widthOf(parts.join(' · ')) > Math.max(10, cols - 24) && parts.length > 3) {
        parts.splice(-1, 1);
    }
    const right = [segments.port ? `:${segments.port}` : '', '/quit  /clear'].filter(Boolean).join(' ');

    // PABCD phase → rail color from jawcode interactive bundle
    let railColor: string | undefined;
    if (segments.orchPhase && isInitialized()) {
        try {
            const inter = getInteractive();
            if (typeof inter.getPabcdBorderColor === 'function') {
                railColor = inter.getPabcdBorderColor(segments.orchPhase);
            }
        } catch { /* fallback to default cyan */ }
    }
    return renderSegmentedStatusLine(parts.join(' · '), right, cols, railColor ? { railColor } : undefined);
}
