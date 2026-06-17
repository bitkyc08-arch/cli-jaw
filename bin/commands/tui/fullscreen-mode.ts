import {
    consumePasteProtocol, getComposerDisplayText, getDisplayCursorOffset, setBracketedPaste,
} from '../../../src/cli/tui/composer.js';
import { renderMarkdown } from '../../../src/cli/tui/markdown.js';
import { renderMarkdownJawcode, isInitialized, getInteractive } from '../../../src/cli/tui/jawcode-render.js';
import { renderToolLine, renderToolBlock, renderThinkingCollapse } from '../../../src/cli/tui/jawcode-bridge.js';
import { classifyKeyAction, splitKeyInput, type KeyAction } from '../../../src/cli/tui/keymap.js';
import { getCompletionItems } from '../../../src/cli/commands.js';
import { composeHelpOntoFrame, composePaletteOntoFrame, composeSelectorOntoFrame, composeBgtaskOntoFrame } from '../../../src/cli/tui/overlay.js';
import { composeSlashSurfaceLines } from '../../../src/cli/tui/slash-surface.js';
import { composeSettingsScreenLines } from '../../../src/cli/tui/settings-screen.js';
import { createScheduler } from '../../../src/cli/tui/render/scheduler.js';
import { Screen, registerScreenCleanup, VIEWPORT_FILL, type Frame } from '../../../src/cli/tui/render/frame.js';
import { solveLayout, type Regions } from '../../../src/cli/tui/render/layout.js';
import { parseSgrMouse, isMouseSequence } from '../../../src/cli/tui/render/mouse.js';
import { Viewport } from '../../../src/cli/tui/render/viewport.js';
import type { TranscriptItem } from '../../../src/cli/tui/transcript.js';
import { listLiveToolItems, toggleToolExpansion } from '../../../src/cli/tui/transcript.js';
import { clipTextToCols, visualWidth, wrapTextToCols } from '../../../src/cli/tui/renderers.js';
import { composeComposerBox, measureComposerVisualRows } from '../../../src/cli/tui/render/composer-box.js';
import { cleanupScrollRegion, resolveShellLayout } from '../../../src/cli/tui/shell.js';
import type { TuiContext } from './types.js';
import { c, getRows, ESC_WAIT_MS } from './types.js';
import { handleKeyInput, flushPendingEscape } from './input-handler.js';
import { handleWsMessage } from './ws-handler.js';
import { redrawInputWithAutocomplete } from './overlays.js';
import { rebuildFooter } from './renderer.js';

const LEADING_TOOL_GLYPH = /^\s*(?:[\p{Extended_Pictographic}\u2600-\u27bf]\ufe0f?)\s+/u;
const READABLE_TEXT = '\x1b[97m';

function parseToolText(text: string): { label: string; detail: string } {
    const [head = '', ...rest] = text.split(':');
    const rawLabel = head.trim();
    const normalizedLabel = rawLabel.replace(LEADING_TOOL_GLYPH, '').trim();
    return {
        label: normalizedLabel || rawLabel,
        detail: rest.join(':').trim(),
    };
}

function countTextLines(text: string): number {
    if (!text) return 1;
    return text.split('\n').length;
}

function wrapPlainLines(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    return text.split('\n').flatMap(line => line.length === 0 ? [''] : wrapTextToCols(line, safeWidth));
}

function renderUserBlock(item: Extract<TranscriptItem, { type: 'user' }>, width: number, gutter: string): string[] {
    const header = `${gutter}${c.cyan}${c.bold}╭─ You${c.reset}`;
    const bodyPrefix = `${gutter}${c.cyan}│${c.reset} `;
    const footer = `${gutter}${c.cyan}╰─${c.reset}`;
    const bodyWidth = Math.max(8, width - visualWidth(bodyPrefix));
    const bodyRows = wrapPlainLines(item.displayText, bodyWidth);
    return [
        clipTextToCols(header, width),
        ...bodyRows.map(line => `${bodyPrefix}${READABLE_TEXT}${clipTextToCols(line, bodyWidth)}${c.reset}`),
        clipTextToCols(footer, width),
    ];
}

export function renderTranscriptItem(item: TranscriptItem, width: number): string[] {
    const gutter = '  ';
    const w = Math.max(20, width - gutter.length);
    switch (item.type) {
        case 'user':
            return renderUserBlock(item, width, gutter);
        case 'assistant': {
            const agentLabel = item.agentId ? `${c.dim}[${item.agentId}]${c.reset} ` : '';
            if (item.streaming && !item.text) {
                return [`${gutter}${agentLabel}${c.cyan}▍${c.reset}`];
            }
            const cursor = item.streaming ? `${c.cyan}▍${c.reset}` : '';
            const header = agentLabel ? `${gutter}${agentLabel}\n` : '';
            // Thinking block detection — jawcode collapses thinking to 1 line when not streaming
            const thinkMatch = !item.streaming && item.text.startsWith('<think');
            if (thinkMatch) {
                const thinkLines = item.text.split('\n').length;
                return [
                    ...(agentLabel ? [`${gutter}${agentLabel}`] : []),
                    renderThinkingCollapse(item.text, thinkLines, false),
                ];
            }
            const mdText = item.text + (cursor ? ` ${cursor}` : '');
            const body = isInitialized()
                ? renderMarkdownJawcode(mdText, w).join('\n')
                : renderMarkdown(mdText, { width: w, gutter });
            return (header + body).split('\n');
        }
        case 'thinking': {
            const agentLabel = item.agentId ? `${c.dim}[${item.agentId}]${c.reset} ` : '';
            const lineCount = countTextLines(item.text);
            const labelRows = agentLabel ? [`${gutter}${agentLabel}`] : [];
            if (item.streaming) {
                const detailPrefix = `${gutter}${c.dim}│ `;
                const detailWidth = Math.max(10, width - visualWidth(detailPrefix) - visualWidth(c.reset));
                const wrappedRows = wrapPlainLines(item.text, detailWidth).slice(-6);
                const detailRows = wrappedRows.length > 0 ? wrappedRows : [''];
                return [
                    ...labelRows,
                    `${gutter}${c.dim}\x1b[3mThinking${c.reset} ${c.cyan}▍${c.reset}`,
                    ...detailRows.map(line => `${detailPrefix}${clipTextToCols(line, detailWidth)}${c.reset}`),
                ];
            }
            if (item.collapsed === false) {
                const detailPrefix = `${gutter}${c.dim}│ `;
                const detailWidth = Math.max(10, width - visualWidth(detailPrefix) - visualWidth(c.reset));
                const detailRows = wrapPlainLines(item.text, detailWidth);
                return [
                    ...labelRows,
                    renderThinkingCollapse(item.text, lineCount, false),
                    ...detailRows.map(line => `${detailPrefix}${clipTextToCols(line, detailWidth)}${c.reset}`),
                ];
            }
            return [
                ...labelRows,
                renderThinkingCollapse(item.text, lineCount, false),
            ];
        }
        case 'tool': {
            const parsed = parseToolText(item.text);
            const toolDetail = item.detail ?? parsed.detail;
            const state = item.status === 'error'
                ? 'error' as const
                : item.status === 'done' ? 'done' as const : 'pending' as const;
            return renderToolBlock(parsed.label, toolDetail, state, {
                collapsed: item.collapsed,
                width: width,
            });
        }
        case 'command': {
            const icon = item.ok === false ? '!' : '✓';
            const color = item.ok === false ? c.red : c.green;
            const label = item.commandName ? `/${item.commandName}: ` : '';
            const prefix = `${gutter}${color}${icon}${c.reset} ${c.dim}${label}${c.reset}`;
            const bodyWidth = Math.max(10, width - visualWidth(prefix));
            const lines = item.text
                .split('\n')
                .flatMap(line => line.length === 0 ? [''] : wrapTextToCols(line, bodyWidth));
            return lines.map((line, index) => {
                const rowPrefix = index === 0 ? prefix : `${gutter}${c.dim}│ ${c.reset}`;
                const rowWidth = Math.max(10, width - visualWidth(rowPrefix));
                return `${rowPrefix}${clipTextToCols(line, rowWidth)}`;
            });
        }
        case 'status': {
            const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            const spinChar = spinnerFrames[Math.floor(Date.now() / 80) % spinnerFrames.length] || '◌';
            return [`${gutter}${c.dim}${spinChar} ${item.text}${c.reset}`];
        }
        default:
            return [];
    }
}


function computeStablePrefixIndex(items: TranscriptItem[]): number {
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.type === 'assistant' && item.streaming) return i;
        if (item.type === 'thinking' && item.streaming) return i;
        if (item.type === 'tool' && item.status === 'running') return i;
        if (item.type === 'status') return i;
    }
    return items.length;
}

function renderTranscriptItemWithSpacing(item: TranscriptItem, width: number, previous?: TranscriptItem): string[] {
    const rows = renderTranscriptItem(item, width);
    const needsGap = Boolean(previous && previous.type !== 'status' && item.type !== 'status');
    return needsGap ? ['', ...rows] : rows;
}

function currentRegions(ctx: TuiContext): Regions {
    const cols = process.stdout.columns || 80;
    const rows = getRows();
    const composerText = getComposerDisplayText(ctx.store.composer);
    const composerLines = measureComposerVisualRows(composerText, getDisplayCursorOffset(ctx.store.composer), cols);
    return solveLayout(cols, rows, composerLines);
}

function overlayBlocksScroll(ctx: TuiContext): boolean {
    const ov = ctx.store.overlay;
    return ov.helpOpen || ov.paletteOpen || ov.selector.open || ov.bgtaskOpen || ov.settingsOpen;
}

function isMouseTrackingEnabled(ctx: TuiContext): boolean {
    return ctx.tuiConfig['mouseTracking'] === true;
}

function handleScrollKey(ctx: TuiContext, viewport: Viewport, action: KeyAction, regions: Regions): boolean {
    if (overlayBlocksScroll(ctx)) return false;
    const ac = ctx.store.autocomplete;
    if (ac.open && (action === 'page-up' || action === 'page-down' || action === 'arrow-up' || action === 'arrow-down')) {
        return false; // autocomplete consumes these
    }
    const h = regions.transcript.height;
    if (action === 'page-up') { viewport.pageUp(h); return true; }
    if (action === 'page-down') { viewport.pageDown(h); return true; }
    return false;
}

function handleMouseEvent(
    viewport: Viewport,
    regions: Regions,
    ev: { kind: string; row: number },
): boolean {
    if (ev.kind !== 'wheel-up' && ev.kind !== 'wheel-down') return false;
    const h = regions.transcript.height;
    viewport.scrollBy(ev.kind === 'wheel-up' ? -3 : 3, h);
    return true;
}

function blankLines(count: number): string[] {
    return new Array(Math.max(0, count)).fill('');
}

function foldToolDetail(detail: string): string {
    const lines = detail.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length <= 1) return lines[0] ?? '';
    return `${lines[0]} … +${lines.length - 1} lines`;
}

function renderLiveToolRows(ctx: TuiContext, cols: number, maxRows: number): string[] {
    if (maxRows <= 0) return [];
    const state = ctx.store.transcript;
    const liveTools = listLiveToolItems(state);
    if (liveTools.length === 0) return [];
    if (!state.liveToolsExpanded) {
        const visible = liveTools.slice(0, Math.max(0, maxRows));
        const rows = visible.map(tool => clipTextToCols(renderToolLine('', tool.label, foldToolDetail(tool.detail), 'pending'), cols));
        if (liveTools.length > visible.length && rows.length > 0) {
            rows[rows.length - 1] = clipTextToCols(`${c.dim}  … +${liveTools.length - visible.length} running tools${c.reset}`, cols);
        }
        return rows;
    }

    const rows: string[] = [];
    const detailPrefix = `${c.dim}  │ ${c.reset}`;
    const detailWidth = Math.max(10, cols - visualWidth(detailPrefix));
    let truncated = false;
    for (const tool of liveTools) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(clipTextToCols(renderToolLine('', tool.label, '', 'pending'), cols));
        if (!tool.detail) continue;
        const detailRows = wrapTextToCols(tool.detail, detailWidth);
        for (let i = 0; i < detailRows.length; i += 1) {
            if (rows.length >= maxRows) { truncated = true; break; }
            rows.push(clipTextToCols(`${detailPrefix}${detailRows[i]}`, cols));
        }
        if (truncated) break;
    }
    if (truncated && rows.length > 0) {
        rows[rows.length - 1] = clipTextToCols(`${c.dim}  … live tool output folded to fit; Ctrl-O toggles${c.reset}`, cols);
    }
    return rows;
}

function renderWelcomePrelude(ctx: TuiContext, cols: number): string[] {
    return (ctx.welcomeLines ?? []).map(line => clipTextToCols(line, cols));
}

function renderChatRegion(ctx: TuiContext, viewport: Viewport, regions: Regions, cols: number, liveRows: string[] = []): string[] {
    if (ctx.store.overlay.settingsOpen) {
        return composeSettingsScreenLines({
            settings: ctx.settingsSnapshot,
            tuiConfig: ctx.tuiConfig,
            footerPreview: ctx.footer,
        }, {
            selected: ctx.store.overlay.settingsSelected,
            message: ctx.store.overlay.settingsMessage,
        }, {
            columns: cols,
            height: regions.transcript.height,
            cyanCode: c.cyan,
            dimCode: c.dim,
            boldCode: c.bold,
            resetCode: c.reset,
            clipTextToCols,
        });
    }
    const MIN_HISTORY_LANE_ROWS = 5;
    const hasItems = liveRows.length > 0 || viewport.totalLines() > 0;
    const reserve = hasItems ? MIN_HISTORY_LANE_ROWS : 0;
    const transcriptHeight = Math.max(1, regions.transcript.height - liveRows.length - reserve);
    return [
        ...viewport.composeRegion({ ...regions.transcript, height: transcriptHeight }),
        ...liveRows,
    ];
}

function renderHelpLine(cols: number): string {
    return clipTextToCols(`${c.gray}? for shortcuts · /help · /model · /settings${c.reset}`, cols);
}

function expandFrameRows(rows: string[], height: number): string[] {
    const idx = rows.indexOf(VIEWPORT_FILL);
    if (idx < 0) return rows;
    const out = [...rows];
    out.splice(idx, 1, ...blankLines(height - (rows.length - 1)));
    return out;
}

export function composeFrame(ctx: TuiContext, viewport: Viewport): Frame {
    const cols = process.stdout.columns || 80;
    const rows = getRows();
    const composerText = getComposerDisplayText(ctx.store.composer);
    const composerLines = measureComposerVisualRows(composerText, getDisplayCursorOffset(ctx.store.composer), cols);
    const ac = ctx.store.autocomplete;
    const slashRows = composeSlashSurfaceLines(ac, {
        columns: cols,
        dimCode: c.dim,
        resetCode: c.reset,
        clipTextToCols,
    });
    const regions = solveLayout(cols, rows, composerLines, { commandSurfaceLines: slashRows.length });
    viewport.setWidth(cols);

    const ov = ctx.store.overlay;
    const liveRows = ov.helpOpen || ov.paletteOpen || ov.selector.open || ov.bgtaskOpen || ov.settingsOpen
        ? []
        : renderLiveToolRows(ctx, cols, Math.min(4, Math.max(0, regions.transcript.height - 1)));
    const hasItemsForLane = ctx.store.transcript.items.length > 0;
    const transcriptHeight = Math.max(1, regions.transcript.height - liveRows.length - (hasItemsForLane ? 5 : 0));
    viewport.setPrelude(renderWelcomePrelude(ctx, cols));
    const transcriptItems = ctx.store.transcript.items;
    viewport.setItems(
        transcriptItems,
        (item, width) => renderTranscriptItemWithSpacing(item, width, transcriptItems[transcriptItems.indexOf(item) - 1]),
        transcriptHeight,
    );

    const chatRows = renderChatRegion(ctx, viewport, regions, cols, liveRows);
    const commandRows = slashRows
        .slice(0, regions.commandSurface.height)
        .map(line => clipTextToCols(line, cols));
    while (commandRows.length < regions.commandSurface.height) commandRows.push('');

    const needsOverlay = ov.helpOpen || ov.paletteOpen || ov.selector.open || ov.bgtaskOpen;
    const anchorLaunchPrelude = !needsOverlay
        && !ov.settingsOpen
        && ctx.store.transcript.items.length === 0
        && viewport.hasUncommittedPreludeRows();
    const frameRows: string[] = anchorLaunchPrelude
        ? [
            ...chatRows,
            VIEWPORT_FILL,
            clipTextToCols(ctx.footer, cols),
            ...commandRows,
        ]
        : [
            VIEWPORT_FILL,
            ...chatRows,
            clipTextToCols(ctx.footer, cols),
            ...commandRows,
        ];

    // Input box with border — width-safe and cursor-aware for IME/wide glyphs.
    const box = isInitialized() ? (() => { try { return getInteractive().theme?.boxSharp; } catch { return null; } })() : null;
    const composerBox = composeComposerBox(
        composerText,
        getDisplayCursorOffset(ctx.store.composer),
        cols,
        regions.composer.height,
        {
            dimCode: c.dim,
            resetCode: c.reset,
            accentCode: ctx.accent,
            boldCode: c.bold,
            textCode: READABLE_TEXT,
            placeholderCode: c.gray,
            border: {
                topLeft: box?.topLeft ?? '┌',
                topRight: box?.topRight ?? '┐',
                bottomLeft: box?.bottomLeft ?? '└',
                bottomRight: box?.bottomRight ?? '┘',
                horizontal: box?.horizontal ?? '─',
                vertical: box?.vertical ?? '│',
            },
        },
    );
    const composerTopRow = frameRows.length;
    frameRows.push(...composerBox.rows.map(row => clipTextToCols(row, cols)));
    frameRows.push(renderHelpLine(cols));

    // For overlays, we need a full-height array. Expand VIEWPORT_FILL now.
    if (needsOverlay) {
        frameRows.splice(0, frameRows.length, ...expandFrameRows(frameRows, rows));
        if (ov.helpOpen) {
            const cmds = getCompletionItems('/', 'cli');
            composeHelpOntoFrame(frameRows, cols, frameRows.length, c.dim, c.reset, cmds);
        } else if (ov.paletteOpen) {
            composePaletteOntoFrame(
                frameRows, cols, frameRows.length, c.dim, c.reset,
                ov.paletteFilter, ov.paletteItems, ov.paletteSelected,
            );
        } else if (ov.selector.open) {
            const sel = ov.selector;
            composeSelectorOntoFrame(
                frameRows, cols, frameRows.length, c.dim, c.reset,
                sel.title, sel.subtitle, sel.filter, sel.filteredItems, sel.selected,
            );
        } else if (ov.bgtaskOpen) {
            composeBgtaskOntoFrame(
                frameRows, cols, frameRows.length, c.dim, c.reset,
                ctx.bgtaskTasks.map((t) => ({ id: t.id, kind: t.kind, status: 'running', elapsed: '' })),
            );
        }
    }

    // Calculate cursor position for the input box
    const showCursor = ctx.inputActive && !needsOverlay && !ov.settingsOpen && !ctx.commandRunning;
    let cursorPos: Frame['cursorPos'];
    if (showCursor) {
        cursorPos = {
            row: composerTopRow + 1 + composerBox.cursor.row,
            col: composerBox.cursor.col,
        };
    }

    const frame: Frame = { rows: frameRows };
    if (cursorPos) frame.cursorPos = cursorPos;
    return frame;
}

export async function runFullscreenMode(ctx: TuiContext): Promise<void> {
    const screen = new Screen();
    registerScreenCleanup(screen);
    const viewport = new Viewport();
    viewport.setWidth(process.stdout.columns || 80);

    const scheduler = createScheduler(() => {
        rebuildFooter(ctx);
        const regions = currentRegions(ctx);
        const liveRows = ctx.store.overlay.helpOpen || ctx.store.overlay.paletteOpen || ctx.store.overlay.selector.open || ctx.store.overlay.bgtaskOpen || ctx.store.overlay.settingsOpen
            ? []
            : renderLiveToolRows(ctx, process.stdout.columns || 80, Math.min(4, Math.max(0, regions.transcript.height - 1)));
        const hasTranscriptItems = ctx.store.transcript.items.length > 0;
        const overlayOpen = ctx.store.overlay.helpOpen || ctx.store.overlay.paletteOpen
            || ctx.store.overlay.selector.open || ctx.store.overlay.bgtaskOpen
            || ctx.store.overlay.settingsOpen;
        const MIN_HISTORY_LANE = 5;
        const transcriptHeight = Math.max(1, regions.transcript.height - liveRows.length - (hasTranscriptItems && !overlayOpen ? MIN_HISTORY_LANE : 0));

        const stablePrefixIndex = hasTranscriptItems
            ? computeStablePrefixIndex(ctx.store.transcript.items) : 0;

        // Only commit when ALL items are stable (turn fully complete, not streaming)
        const allStable = stablePrefixIndex === ctx.store.transcript.items.length;
        const commit = hasTranscriptItems && !overlayOpen && allStable
            ? viewport.peekStableCommitRows(transcriptHeight, stablePrefixIndex)
            : null;

        if (commit) screen.queueCommitLines(commit.rows);

        const renderViewport = commit
            ? viewport.withPreviewFrontier(commit.frontier)
            : viewport;

        screen.render(composeFrame(ctx, renderViewport));

        const flushed = screen.lastCommitFlushedCount();
        if (flushed > 0 && commit) {
            viewport.markCommittedFrontier(commit.frontier);
        }

    });

    ctx.displayMode = 'fullscreen';
    ctx.requestFrame = () => scheduler.request();

    rebuildFooter(ctx);
    screen.enter();
    if (isMouseTrackingEnabled(ctx)) screen.enableMouse();
    else screen.disableMouse();
    scheduler.request();

    process.stdin.setRawMode(true);
    setBracketedPaste(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdout.on('resize', () => {
        viewport.setWidth(process.stdout.columns || 80);
        screen.forceResizeRedraw();
        scheduler.request();

        if (ctx.resizeTimer) clearTimeout(ctx.resizeTimer);
        ctx.resizeTimer = setTimeout(() => {
            ctx.resizeTimer = null;
            viewport.setWidth(process.stdout.columns || 80);
            screen.forceResizeRedraw();
            scheduler.request();
        }, 50);
    });

    process.stdin.on('data', (rawKey) => {
        let incoming = rawKey as unknown as string;
        const mouseTrackingEnabled = isMouseTrackingEnabled(ctx);
        if (mouseTrackingEnabled && isMouseSequence(incoming)) {
            const parsed = parseSgrMouse(incoming);
            if (parsed) {
                const regions = currentRegions(ctx);
                if (handleMouseEvent(viewport, regions, parsed.event)) {
                    scheduler.request();
                    return;
                }
                return;
            }
        }

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
            }
            void redrawInputWithAutocomplete(ctx).then(() => scheduler.request());
            if (tokens.length === 0) return;
        }

        const regions = currentRegions(ctx);
        for (const token of tokens.flatMap(splitKeyInput)) {
            const action = classifyKeyAction(token);
            if (action === 'ctrl-o') {
                if (toggleToolExpansion(ctx.store.transcript)) scheduler.request();
                continue;
            }
            if (action === 'ctrl-l') {
                // Model selector — dispatch /model command
                handleKeyInput(ctx, '/');
                handleKeyInput(ctx, 'm');
                handleKeyInput(ctx, 'o');
                handleKeyInput(ctx, 'd');
                handleKeyInput(ctx, 'e');
                handleKeyInput(ctx, 'l');
                handleKeyInput(ctx, '\r');
                continue;
            }
            if (action === 'ctrl-r') {
                // Resume session — dispatch /resume
                handleKeyInput(ctx, '/');
                handleKeyInput(ctx, 'r');
                handleKeyInput(ctx, 'e');
                handleKeyInput(ctx, 's');
                handleKeyInput(ctx, 'u');
                handleKeyInput(ctx, 'm');
                handleKeyInput(ctx, 'e');
                handleKeyInput(ctx, '\r');
                continue;
            }
            if (action === 'ctrl-d') {
                if (!ctx.commandRunning && !ctx.inputActive) {
                    scheduler.dispose();
                    screen.disableMouse();
                    screen.exit();
                    process.exit(0);
                }
                continue;
            }
            if (handleScrollKey(ctx, viewport, action, regions)) {
                scheduler.request();
                continue;
            }
            const beforeTranscriptCount = ctx.store.transcript.items.length;
            handleKeyInput(ctx, token);
            if (ctx.store.transcript.items.length > beforeTranscriptCount) {
                viewport.followTail(true, currentRegions(ctx).transcript.height);
            }
            scheduler.request();
        }
    });

    ctx.ws.on('message', (data) => {
        handleWsMessage(ctx, data);
        if (ctx.streaming && viewport.isFollowingTail()) {
            viewport.followTail(true, currentRegions(ctx).transcript.height);
        }
        scheduler.request();
    });

    ctx.inputActive = true;
    scheduler.request();

    return new Promise<void>((resolve) => {
        ctx.ws.on('close', () => {
            scheduler.dispose();
            screen.disableMouse();
            screen.exit();
            cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), ctx.store.panes));
            setBracketedPaste(false);
            process.stdin.setRawMode(false);
            resolve();
        });
    });
}
