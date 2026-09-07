/**
 * TUI rendering: prompt, block separators, footer.
 */
import { getComposerDisplayText, getDisplayCursorOffset } from '../../../src/cli/tui/composer.js';
import { closeAutocomplete } from '../../../src/cli/tui/overlay.js';
import { visualWidth, cursorScreenPos, layoutComposerText } from '../../../src/cli/tui/renderers.js';
import { resolveShellLayout, setupScrollRegion } from '../../../src/cli/tui/shell.js';
import { c, hrLine, getRows, type TuiContext } from './types.js';
import { renderStatusBar } from '../../../src/cli/tui/presentation.js';

const contPrefixFor = () => `  ${c.dim}\u00B7 ${c.reset}`;

/** Count wrapped visual rows for the composer block (line-mode). */
export function computeComposerVisualRows(
    displayText: string,
    cols: number,
    promptPrefix: string,
    contPrefix = contPrefixFor(),
): number {
    return cursorScreenPos(displayText, 0, visualWidth(promptPrefix), visualWidth(contPrefix), cols).totalRows;
}

function clearTerminalRows(rows: number, cursorRow: number): void {
    const safeRows = Math.max(1, rows);
    const atRow = Math.max(0, Math.min(cursorRow, safeRows - 1));
    if (atRow > 0) process.stdout.write(`\x1b[${atRow}A`);
    process.stdout.write('\r');
    for (let i = 0; i < safeRows; i++) {
        process.stdout.write('\x1b[2K');
        if (i < safeRows - 1) process.stdout.write('\x1b[1B');
    }
    if (safeRows > 1) process.stdout.write(`\x1b[${safeRows - 1}A`);
    process.stdout.write('\r');
}

/** Erase the on-screen composer block and reset row tracking (line-mode). */
export function clearPromptBlock(ctx: TuiContext, rows = ctx.prevLineCount): void {
    if (ctx.displayMode === 'fullscreen') return;
    clearTerminalRows(Math.max(1, rows), ctx.promptCursorRow);
    ctx.prevLineCount = 1;
    ctx.promptCursorRow = 0;
    setupScrollRegion(
        ctx.footer,
        `  ${c.dim}${hrLine()}${c.reset}`,
        resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes),
    );
}

export function rebuildFooter(ctx: TuiContext): void {
    const elapsed = ctx.streamState !== 'idle' && ctx.turnStartedAt > 0
        ? Date.now() - ctx.turnStartedAt
        : undefined;
    const stateStr = ctx.streamState === 'responding' ? 'responding\u2026' : ctx.streamState === 'tool' ? 'working\u2026' : 'idle';
    const projectDisplay = ctx.projectRoot ? shortenProjectPathForFooter(ctx.projectRoot) : undefined;
    ctx.footer = renderStatusBar({
        model: ctx.info?.model,
        engine: ctx.label,
        engineAccent: ctx.accent,
        state: stateStr,
        elapsed: elapsed && elapsed > 0 ? `${(elapsed / 1000).toFixed(1)}s` : undefined,
        bgtask: ctx.bgtaskCount,
        bgtaskAttention: ctx.bgtaskAttention,
        gitBranch: ctx.isGit ? (ctx.gitBranch || 'agent') : undefined,
        cwd: projectDisplay || ctx.info?.workingDir,
        port: ctx.serverPort,
        orchPhase: ctx.orchPhase,
    });
    ctx.promptPrefix = `  ${ctx.accent}${c.bold}\u276F${c.reset} `;
    if (ctx.displayMode === 'fullscreen') return;
    const preserveCursor = ctx.store.transcript.items.some(item => item.type === 'activity' && item.lineActiveItemId !== null);
    if (preserveCursor) process.stdout.write('\x1b7');
    setupScrollRegion(
        ctx.footer,
        `  ${c.dim}${hrLine()}${c.reset}`,
        resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes),
    );
    if (preserveCursor) process.stdout.write('\x1b8');
}

export function shortenProjectPathForFooter(projectRoot: string): string {
    const home = process.env['HOME'] || '';
    const rel = home && projectRoot.startsWith(home) ? projectRoot.replace(home, '~') : projectRoot;
    const parts = rel.split('/').filter(Boolean);
    if (parts.length <= 3) return rel;
    return `.../${parts.slice(-2).join('/')}`;
}

export function renderBlockSeparator(): void {
    process.stdout.write('\n');
    console.log(`  ${c.dim}${hrLine()}${c.reset}`);
}

export function renderAssistantTurnStart(): void {
    process.stdout.write('\n  ');
}

export function showPrompt(ctx: TuiContext): void {
    closeAutocomplete(ctx.store.autocomplete, (chunk) => process.stdout.write(chunk));
    ctx.prevLineCount = 1;
    ctx.promptCursorRow = 0;
    process.stdout.write(ctx.promptPrefix);
}

export function openPromptBlock(ctx: TuiContext): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.inputActive = true;
        ctx.requestFrame?.();
        return;
    }
    renderBlockSeparator();
    showPrompt(ctx);
}

export function reopenPromptLine(ctx: TuiContext): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.inputActive = true;
        ctx.requestFrame?.();
        return;
    }
    process.stdout.write('\n');
    showPrompt(ctx);
}

export function redrawPromptLine(ctx: Pick<TuiContext, 'displayMode' | 'requestFrame' | 'store' | 'promptPrefix' | 'prevLineCount' | 'promptCursorRow'>): void {
    if (ctx.displayMode === 'fullscreen') {
        ctx.requestFrame?.();
        return;
    }
    const cols = process.stdout.columns || 80;
    const oldRows = Math.max(1, ctx.prevLineCount);
    const displayText = getComposerDisplayText(ctx.store.composer);
    const contPrefix = contPrefixFor();
    const layout = layoutComposerText(displayText, getDisplayCursorOffset(ctx.store.composer), cols, ctx.promptPrefix, contPrefix);
    const totalRows = layout.totalRows;
    const clearRows = Math.max(oldRows, totalRows);

    clearTerminalRows(clearRows, ctx.promptCursorRow);

    const lines = layout.rows;
    for (let i = 0; i < lines.length; i++) {
        process.stdout.write(lines[i]!);
        if (i < lines.length - 1) process.stdout.write('\n');
    }
    ctx.prevLineCount = totalRows;

    const pos = layout.cursor;
    const up = (totalRows - 1) - pos.row;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    process.stdout.write('\r');
    if (pos.col > 0) process.stdout.write(`\x1b[${pos.col}C`);
    ctx.promptCursorRow = pos.row;
}

/** A late read may finish after the user has resumed typing. Move the composer
 * below the new output without changing its draft, cursor or turn lifecycle. */
export function writeAboveComposer(ctx: TuiContext, text: string): void {
    if (!text) return;
    if (!ctx.inputActive || ctx.commandRunning) { process.stdout.write('\n' + text); return; }
    clearTerminalRows(ctx.prevLineCount, ctx.promptCursorRow);
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    ctx.prevLineCount = 1;
    ctx.promptCursorRow = 0;
    redrawPromptLine(ctx);
}
