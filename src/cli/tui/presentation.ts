/** Local cli-jaw transcript and footer presentation. */
import { sharkIcon } from './icons.js';
import { renderJawWelcome } from './welcome-jaw.js';
import { clipTextToCols, visualWidth, wrapTextToCols } from './renderers.js';
import { paint, attr, BOLD, ITALIC } from './theme.js';

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

export function renderToolLine(_icon: string, label: string, detail: string, state: 'pending' | 'done' | 'error', opts?: { depth?: number; isLast?: boolean; elapsed?: string }): string {
    const detailLines = detail.split('\n').map(line => line.trim()).filter(Boolean);
    const firstDetail = detailLines[0] ?? '';
    const foldedHint = detailLines.length > 1
        ? `: ${firstDetail} … +${detailLines.length - 1} lines`
        : firstDetail ? `: ${firstDetail}` : '';
    // Header rows always use the folded hint (first line … +K lines) — raw
    // multi-line detail in a header becomes one unbounded logical row (the
    // frame flattens newlines to spaces). jawcode 036d1ab preview-cap parity;
    // expanded blocks print their detail rows separately in renderToolBlock.
    const stateIcon = state === 'done' ? paint('diff.add', '✔') : state === 'error' ? paint('status.error', '✖') : paint('accent', '⏳');
    const depth = Math.max(0, Math.floor(opts?.depth ?? 0));
    const treePre = depth > 0 ? `${'  '.repeat(depth - 1)}${opts?.isLast ? '└─ ' : '├─ '}` : '';
    const elapsedStr = opts?.elapsed ? ` ${paint('text.muted', opts.elapsed)}` : '';
    const hint = foldedHint ? paint('text.muted', foldedHint) : '';
    return `  ${treePre}${stateIcon} ${attr(label, BOLD)}${hint}${elapsedStr}`;
}

/**
 * Multi-line tool block for fullscreen transcript rendering.
 * Returns an array of rows: header + optional detail preview.
 */
export function renderToolBlock(label: string, detail: string, state: 'pending' | 'done' | 'error', opts?: {
    collapsed?: boolean | undefined;
    width?: number | undefined;
    depth?: number;
    isLast?: boolean;
    elapsed?: string;
}): string[] {
    const width = opts?.width ?? (process.stdout.columns || 80);
    const detailLines = detail.split('\n').map(line => line.trim()).filter(Boolean);
    const expanded = opts?.collapsed === false;

    // Header line
    const headerLine = renderToolLine('', label, expanded ? '' : detail, state, opts);
    const rows: string[] = [clipTextToCols(headerLine, width)];

    // Detail block — show when expanded (collapsed === false) and there are detail lines
    if (expanded && detailLines.length > 0) {
        const indent = '  '.repeat(Math.max(0, Math.floor(opts?.depth ?? 0)));
        const prefix = `  ${indent}${paint('text.muted', '│')} `;
        const detailWidth = Math.max(0, width - visualWidth(prefix));
        const maxRows = 14;
        for (let i = 0; i < Math.min(detailLines.length, maxRows); i++) {
            const line = detailLines[i]!;
            const clipped = visualWidth(line) > detailWidth
                ? clipTextToCols(line, Math.max(0, detailWidth - 1)) + (detailWidth > 0 ? '…' : '')
                : line;
            rows.push(clipTextToCols(`${prefix}${paint('text.muted', clipped)}`, width));
        }
        if (detailLines.length > maxRows) {
            rows.push(clipTextToCols(`${prefix}${paint('text.muted', `… +${detailLines.length - maxRows} lines`)}`, width));
        }
    }

    return rows;
}


export function renderThinkingCollapse(text: string, lineCount: number, expanded: boolean): string {
    return `  ${paint('text.muted', attr(expanded ? text : `Thinking … +${lineCount} lines`, ITALIC))}`;
}

export function renderSubagentTree(agents: Array<{
    name: string;
    status: string;
    elapsed?: string;
    model?: string;
    description?: string;
    children?: Array<{ label: string; detail?: string }>;
}>, width = process.stdout.columns || 80): string[] {
    const lines: string[] = [];
    for (let i = 0; i < agents.length; i++) {
        const a = agents[i]!;
        const isLast = i === agents.length - 1;
        const pre = isLast ? '└─' : '├─';
        const stIcon = a.status === 'completed' ? paint('diff.add', '✔') : a.status === 'running' ? paint('accent', '⏳') : a.status === 'error' || a.status === 'failed' ? paint('status.error', '✖') : paint('text.muted', '①');
        lines.push(`  ${pre} ${stIcon} ${attr(a.name, BOLD)}${a.elapsed ? ` ${paint('text.muted', a.elapsed)}` : ''}`);
        if (a.description) lines.push(`  ${isLast ? '   ' : '│  '}${paint('text.muted', `Description: ${a.description}`)}`);
        if (a.model) lines.push(`  ${isLast ? '   ' : '│  '}${paint('text.muted', `Agent: ${a.model}`)}`);
        if (a.children) {
            for (let j = 0; j < a.children.length; j++) {
                const ch = a.children[j]!;
                const chPre = j === a.children.length - 1 ? '└─' : '├─';
                lines.push(`  ${isLast ? '   ' : '│  '}${chPre} ${paint('text.muted', `${ch.label}${ch.detail ? `: ${ch.detail}` : ''}`)}`);
            }
        }
    }
    return lines.flatMap(line => wrapTextToCols(line, width));
}

function renderSegment(text: string): string {
    // Cell clipping terminates SGR; keep the segment background through its padding.
    return `\x1b[46m\x1b[30m ${text.replace(/\x1b\[0m$/u, '')} \x1b[0m`;
}

function renderSegmentedStatusLine(left: string, right: string, cols: number): string {
    const prefix = '  ';
    const safeCols = Math.max(20, cols);
    const rightBudget = Math.max(8, Math.min(Math.floor(safeCols * 0.35), safeCols - 10));
    const clippedRight = clipTextToCols(right, rightBudget);
    const rightSeg = renderSegment(clippedRight);
    const leftBudget = Math.max(1, safeCols - visualWidth(prefix) - visualWidth(rightSeg) - 2);
    const leftSeg = renderSegment(clipTextToCols(left, leftBudget));
    const railWidth = Math.max(0, safeCols - visualWidth(prefix) - visualWidth(leftSeg) - visualWidth(rightSeg));
    const rail = `\x1b[36m${'─'.repeat(railWidth)}\x1b[0m`;
    return `${prefix}${leftSeg}${rail}${rightSeg}`;
}

export function renderStatusBar(segments: {
    model?: string;
    engine: string;
    engineAccent: string;
    state: string;
    elapsed?: string | undefined;
    bgtask?: number | undefined;
    /** jawcode attention latch — appends `!` to the bgtask badge. */
    bgtaskAttention?: boolean | undefined;
    gitBranch?: string | undefined;
    cwd?: string | undefined;
    port?: number | undefined;
    orchPhase?: string | undefined;
}): string {
    const icon = sharkIcon();
    const parts: string[] = [];
    const cols = process.stdout.columns || 80;
    // Segment-safe styles: the left segment renders on the cyan status
    // background (renderSegment sets 46;30), so parts must not repaint the
    // foreground with theme colors (cyan-on-cyan in dark mode) and must not
    // emit \x1b[0m, which would drop the background mid-segment. Only
    // intensity toggles (1/2 … 22) are safe here.
    const style = {
        strong: (text: string) => `\x1b[1m${text}\x1b[22m`,
        soft: (text: string) => `\x1b[2m${text}\x1b[22m`,
    };
    if (segments.model) parts.push(style.strong(segments.model));
    parts.push(style.strong(`${icon} ${segments.engine}`));
    parts.push(segments.state === 'idle' ? style.soft(segments.state) : style.strong(segments.state));
    if (segments.elapsed) parts.push(style.soft(segments.elapsed));
    // jawcode compact-badge attention suffix: `⏳2!` until the panel is opened.
    if (segments.bgtask && segments.bgtask > 0) parts.push(style.strong(`⏳${segments.bgtask}${segments.bgtaskAttention ? '!' : ''}`));
    else if (segments.bgtaskAttention) parts.push(style.strong('⏳!'));
    if (segments.orchPhase) parts.push(style.strong(`📋${segments.orchPhase.toUpperCase()}`));
    if (segments.gitBranch) parts.push(style.soft(`ⴲ ${segments.gitBranch}`));
    if (segments.cwd) parts.push(style.soft(`📁 ${segments.cwd}`));
    while (visualWidth(parts.join(' · ')) > Math.max(10, cols - 24) && parts.length > 3) {
        parts.splice(-1, 1);
    }
    const right = [segments.port ? `:${segments.port}` : '', '/quit  /clear'].filter(Boolean).join(' ');

    return renderSegmentedStatusLine(parts.join(' · '), right, cols);
}
