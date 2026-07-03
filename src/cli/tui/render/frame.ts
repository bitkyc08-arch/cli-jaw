/**
 * Inline frame buffer + differential rendering (no alt-screen).
 * Renders on the main screen buffer. Launch deliberately clears visible and
 * saved pre-existing terminal lines so `jaw chat` starts like a fresh terminal
 * — EXCEPT in a foreign multiplexer (tmux/GNU screen), whose pane scrollback
 * belongs to the user and is never 3J'd (260703 F1/F2; cmux is first-party and
 * keeps the fresh-terminal contract). Multiplexer-aware preservation applies
 * to post-launch repaint/resize as before.
 * Uses synchronized output (CSI 2026) for flicker-free updates.
 */

import { clipTextToCols } from '../renderers.js';

export const VIEWPORT_FILL = '\x00__VIEWPORT_FILL__\x00';

export interface Frame {
    rows: string[];
    cursorPos?: { row: number; col: number };
}

/** Legacy diffFrames for test compatibility. */
export function diffFrames(prev: Frame | null, next: Frame): string {
    if (!prev || prev.rows.length === 0) {
        let out = '';
        for (let i = 0; i < next.rows.length; i++) {
            if (i > 0) out += '\r\n';
            out += '\x1b[2K' + (next.rows[i] ?? '');
        }
        return out;
    }
    const max = Math.max(prev.rows.length, next.rows.length);
    let out = '';
    for (let i = 0; i < max; i++) {
        const a = prev.rows[i] ?? '';
        const b = next.rows[i] ?? '';
        if (a !== b) {
            out += `\x1b[${i + 1};1H\x1b[2K${b}`;
        }
    }
    return out;
}

/**
 * Expand VIEWPORT_FILL sentinel: replace it with enough blank lines to pad
 * the frame to terminal height, pinning actual content at the bottom.
 * If content exceeds terminal height, sentinel is removed (no padding).
 */
function normalizeFrameRows(lines: string[], height: number): { rows: string[]; droppedTop: number; paddedTop: number; sentinelIndex: number; sentinelDelta: number; fillRows: number } {
    const safeHeight = Math.max(1, height);
    const idx = lines.indexOf(VIEWPORT_FILL);
    let rows = [...lines];
    let sentinelDelta = 0;
    if (idx !== -1) {
        const contentCount = rows.length - 1;
        const fillCount = Math.max(0, safeHeight - contentCount);
        sentinelDelta = fillCount - 1;
        rows.splice(idx, 1, ...new Array(fillCount).fill(''));
    }
    let paddedTop = 0;
    if (rows.length < safeHeight) {
        paddedTop = safeHeight - rows.length;
        rows = [...new Array(paddedTop).fill(''), ...rows];
    }
    const fillRows = idx === 0 && sentinelDelta >= 0 ? sentinelDelta + 1 : 0;
    if (rows.length <= safeHeight) return { rows, droppedTop: 0, paddedTop, sentinelIndex: idx, sentinelDelta, fillRows };
    const droppedTop = rows.length - safeHeight;
    return { rows: rows.slice(droppedTop), droppedTop, paddedTop, sentinelIndex: idx, sentinelDelta, fillRows: 0 };
}

function normalizeFrameRow(row: string, width: number): string {
    return clipTextToCols(row.replace(/[\r\n]+/g, ' '), width);
}

function normalizeCursorRow(row: number, normalized: ReturnType<typeof normalizeFrameRows>, rowCount: number): number {
    let nextRow = row;
    if (normalized.sentinelIndex >= 0 && row > normalized.sentinelIndex) {
        nextRow += normalized.sentinelDelta;
    }
    nextRow += normalized.paddedTop;
    nextRow -= normalized.droppedTop;
    return Math.max(0, Math.min(rowCount - 1, nextRow));
}

/**
 * Inline Screen: renders frames on the main terminal buffer using relative
 * cursor movement and differential row updates. No alternate screen buffer.
 *
 * VIEWPORT_FILL sentinel in frame rows is expanded to blank lines that push
 * content to the terminal bottom — preserving Welcome banner in scrollback.
 */
export class Screen {
    private prevLines: string[] = [];
    private inlineActive = false;
    private cursorRow = 0;
    private fullRedrawPending = false;
    private resizeRedrawPending = false;
    private lastFillRows = 0;
    private committedScreenRows = 0;
    /**
     * 260703 F4 — 1-based bottom row of the on-screen committed block; 0 = the
     * block hugs the current fill bottom (legacy). Set at flush time. When the
     * frontier hides committed items the frame shrinks and the fill REGROWS
     * past the block; scroll-outs must then key off the block bottom, not the
     * raw fill, or they push the blank rows above the block into scrollback —
     * blank bands between turns (port of jawcode c109b78).
     */
    private committedBottomRow = 0;
    private lastWidth = 0;
    private lastHeight = 0;
    private launchClearPending = false;
    private scrollbackProtected = false;
    private hasNativeCommit = false;
    private pendingCommitLines: string[] = [];
    private lastFlushed = 0;
    private lastDeferredByStaleRows = false;

    get active(): boolean {
        return this.inlineActive;
    }

    enter(): void {
        if (this.inlineActive) return;
        process.stdout.write('\x1b[?25l');
        this.inlineActive = true;
        this.prevLines = [];
        this.cursorRow = 0;
        this.fullRedrawPending = false;
        this.resizeRedrawPending = false;
        this.lastFillRows = 0;
        this.committedScreenRows = 0;
        this.committedBottomRow = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = true;
        this.scrollbackProtected = false;
    }

    exit(): void {
        if (!this.inlineActive) return;
        const lastRow = this.prevLines.length - 1;
        if (lastRow > this.cursorRow) {
            process.stdout.write(`\x1b[${lastRow - this.cursorRow}B`);
        }
        process.stdout.write('\r\n\x1b[?25h');
        this.inlineActive = false;
        this.prevLines = [];
        this.cursorRow = 0;
        this.fullRedrawPending = false;
        this.resizeRedrawPending = false;
        this.lastFillRows = 0;
        this.committedScreenRows = 0;
        this.committedBottomRow = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = false;
        this.scrollbackProtected = false;
    }

    needsResizeRepaint(): boolean {
        if (!this.inlineActive) return false;
        const height = process.stdout.rows || 24;
        const width = Math.max(1, process.stdout.columns || 80);
        return this.resizeRedrawPending || this.geometryChanged(width, height);
    }

    private geometryChanged(width: number, height: number): boolean {
        if (this.prevLines.length === 0) return false;
        return (this.lastWidth > 0 && this.lastWidth !== width)
            || (this.lastHeight > 0 && this.lastHeight !== height);
    }

    render(next: Frame): void {
        if (!this.inlineActive) return;
        const height = process.stdout.rows || 24;
        const width = Math.max(1, process.stdout.columns || 80);
        const widthChanged = this.prevLines.length > 0 && this.lastWidth > 0 && this.lastWidth !== width;
        const heightChanged = this.prevLines.length > 0 && this.lastHeight > 0 && this.lastHeight !== height;
        const dimensionChanged = widthChanged || heightChanged;
        if (dimensionChanged) {
            this.fullRedrawPending = true;
            this.resizeRedrawPending = true;
        }
        const normalized = normalizeFrameRows(next.rows.map(row => normalizeFrameRow(row, width)), height);
        const lines = normalized.rows;
        const cursorPos = next.cursorPos
            ? {
                row: normalizeCursorRow(next.cursorPos.row, normalized, lines.length),
                col: Math.max(0, Math.min(width - 1, next.cursorPos.col)),
            }
            : undefined;

        let buf = '\x1b[?2026h';
        if (this.launchClearPending) {
            buf += buildLaunchClearSequence();
            this.cursorRow = 0;
            this.committedScreenRows = 0;
            this.committedBottomRow = 0;
            this.launchClearPending = false;
        }

        // Flush pending scrollback commits (sub-region, non-destructive).
        // Deferred when the rows the commit scroll would push out still hold
        // pixels from the previous frame layout (e.g. the launch-anchored
        // welcome on the frame that releases the anchor): the flush runs
        // BEFORE the diff repaint, so scrolling those rows out would push the
        // stale pixels into scrollback, interleaving them with committed
        // lines. Skipping leaves the frontier unadvanced; the scheduler
        // re-queues the same commit next frame, after the repaint blanked the
        // region. (Physical committed-lane residue is invisible to prevLines —
        // fill rows stay '' in the frame model — so residue still flushes.)
        this.lastFlushed = 0;
        this.lastDeferredByStaleRows = false;
        const parkedBottom = this.committedBottomRow > 0 && this.committedScreenRows > 0
            ? Math.min(this.committedBottomRow, Math.min(normalized.fillRows, height))
            : 0;
        const flushZoneTop = parkedBottom >= 2 ? parkedBottom : Math.min(normalized.fillRows, height);
        if (this.pendingCommitLines.length > 0 && normalized.fillRows >= 2
            && !this.commitScrollOutRowsAreBlank(this.pendingCommitLines.length, flushZoneTop)) {
            // Defer: the repaint below blanks the region; the caller may retry
            // next frame (this is the only defer reason worth a retry — other
            // skips are geometry/lane constraints that a retry cannot change).
            this.lastDeferredByStaleRows = true;
        }
        if (this.pendingCommitLines.length > 0 && normalized.fillRows >= 2 && !this.lastDeferredByStaleRows) {
            // 260703 F4: while a committed block is parked above a regrown fill
            // (frontier hid its items → shorter frame → taller fill), insert
            // DIRECTLY below the block so the committed region stays contiguous
            // — inserting at the raw fill bottom would leave blank rows inside
            // the history region that later scroll-outs stamp into scrollback.
            const liveZoneTop = flushZoneTop;
            buf += `\x1b[1;${liveZoneTop}r`;
            buf += `\x1b[${liveZoneTop};1H`;
            for (const line of this.pendingCommitLines) {
                buf += '\r\n\x1b[2K' + line;
            }
            buf += '\x1b[r\x1b[H';
            this.cursorRow = 0;
            this.committedScreenRows = Math.min(
                this.committedScreenRows + this.pendingCommitLines.length,
                liveZoneTop
            );
            this.committedBottomRow = liveZoneTop;
            this.lastFlushed = this.pendingCommitLines.length;
            this.hasNativeCommit = true;
            this.scrollbackProtected = true;
        }
        this.pendingCommitLines = [];

        if (!this.resizeRedrawPending && this.committedScreenRows > 0) {
            // 260703 F4: scroll the HISTORY REGION, whose bottom is the parked
            // committed block's end — not the raw fill bottom. While the fill
            // is taller than the block (regrowth between turns) growth is
            // absorbed by painting the gap; only once the fill drops below the
            // block bottom does the block scroll, content-only, into
            // scrollback (blank rows above it can never precede it).
            const historyBottom = this.committedBottomRow > 0
                ? Math.min(this.committedBottomRow, height)
                : this.lastFillRows;
            if (normalized.fillRows < historyBottom) {
                // Blank rows sitting ABOVE the committed block inside the
                // history region (unsaturated flush, e.g. 1 committed row in a
                // 5-row fill) must never reach the scrollback — DELETE them in
                // place (DL shifts the block up, opens blanks at the region
                // bottom, pushes nothing out); only actual committed content
                // scrolls out through the region top (audit trace: overlay
                // open drops fill to 0 and stamped 4 blanks before the row).
                const shrink = historyBottom - normalized.fillRows;
                const blanksAbove = Math.max(0, historyBottom - this.committedScreenRows);
                const deleteCount = Math.min(shrink, blanksAbove);
                const scrollCount = shrink - deleteCount;
                if (deleteCount > 0 && historyBottom >= 2) {
                    buf += `\x1b[1;${historyBottom}r\x1b[1;1H\x1b[${deleteCount}M\x1b[r`;
                    buf += `\x1b[${Math.min(height - 1, Math.max(0, this.cursorRow)) + 1};1H`;
                }
                if (scrollCount > 0) {
                    buf += this.buildShrinkScrollOut(scrollCount, historyBottom - deleteCount);
                }
                this.committedScreenRows = Math.min(this.committedScreenRows, normalized.fillRows);
                this.committedBottomRow = this.committedScreenRows > 0 ? normalized.fillRows : 0;
            }
        }

        if (this.resizeRedrawPending) {
            const mode = this.resizeRepaintMode(widthChanged, heightChanged);
            if (mode === 'viewport-only') {
                if (normalized.fillRows < this.lastFillRows) {
                    this.committedScreenRows = Math.min(this.committedScreenRows, normalized.fillRows);
                }
                buf += buildViewportRepaintSequence(lines, height);
            } else {
                if (this.scrollbackProtected && this.committedScreenRows > 0 && this.lastFillRows > 0) {
                    const flushBottom = this.committedBottomRow > 0
                        ? Math.min(this.committedBottomRow, height) : this.lastFillRows;
                    buf += this.buildShrinkScrollOut(flushBottom, flushBottom);
                }
                this.committedScreenRows = 0;
                this.committedBottomRow = 0;
                buf += buildFullClearSequence(mode === 'discard-scrollback');
                buf += buildViewportRepaintSequence(lines, height);
            }
            this.cursorRow = Math.max(0, Math.min(lines.length, height) - 1);
            this.fullRedrawPending = false;
            this.resizeRedrawPending = false;
        } else if (this.fullRedrawPending || this.prevLines.length === 0) {
            if (this.fullRedrawPending && this.committedScreenRows > 0 && this.lastFillRows > 0) {
                const flushBottom = this.committedBottomRow > 0
                    ? Math.min(this.committedBottomRow, height) : this.lastFillRows;
                buf += this.buildShrinkScrollOut(flushBottom, flushBottom);
                this.committedScreenRows = 0;
                this.committedBottomRow = 0;
            }
            if (this.fullRedrawPending && this.prevLines.length > 0 && this.cursorRow > 0) {
                buf += `\x1b[${this.cursorRow}A`;
            }
            buf += '\r';
            const redrawRows = Math.min(height, Math.max(lines.length, this.prevLines.length));
            for (let i = 0; i < redrawRows; i++) {
                if (i > 0) buf += '\r\n';
                buf += '\x1b[2K' + (i < lines.length ? (lines[i] ?? '') : '');
            }
            this.cursorRow = Math.max(0, Math.min(lines.length, redrawRows) - 1);
            this.fullRedrawPending = false;
        } else {
            const prevLen = this.prevLines.length;
            const nextLen = lines.length;

            if (nextLen > prevLen) {
                let firstChanged = -1;
                for (let i = 0; i < prevLen; i++) {
                    if (this.prevLines[i] !== lines[i]) { firstChanged = i; break; }
                }
                if (firstChanged === -1) firstChanged = prevLen;

                if (firstChanged < prevLen) {
                    const moveUp = this.cursorRow - firstChanged;
                    if (moveUp > 0) buf += `\x1b[${moveUp}A`;
                    else if (moveUp < 0) buf += `\x1b[${-moveUp}B`;
                    buf += '\r';
                    for (let i = firstChanged; i < prevLen; i++) {
                        if (i > firstChanged) buf += '\r\n';
                        buf += '\x1b[2K' + (lines[i] ?? '');
                    }
                    this.cursorRow = prevLen - 1;
                }

                const moveToEnd = (prevLen - 1) - this.cursorRow;
                if (moveToEnd > 0) buf += `\x1b[${moveToEnd}B`;
                for (let i = prevLen; i < nextLen; i++) {
                    buf += '\r\n\x1b[2K' + (lines[i] ?? '');
                }
                this.cursorRow = nextLen - 1;
            } else {
                let firstChanged = -1;
                let lastChanged = -1;
                const max = Math.max(prevLen, nextLen);
                for (let i = 0; i < max; i++) {
                    const a = i < prevLen ? this.prevLines[i] : '';
                    const b = i < nextLen ? lines[i] : '';
                    if (a !== b) {
                        if (firstChanged === -1) firstChanged = i;
                        lastChanged = i;
                    }
                }

                if (firstChanged >= 0) {
                    const moveUp = this.cursorRow - firstChanged;
                    if (moveUp > 0) buf += `\x1b[${moveUp}A`;
                    else if (moveUp < 0) buf += `\x1b[${-moveUp}B`;
                    buf += '\r';

                    for (let i = firstChanged; i <= lastChanged; i++) {
                        if (i > firstChanged) buf += '\r\n';
                        buf += '\x1b[2K' + (i < nextLen ? (lines[i] ?? '') : '');
                    }
                    this.cursorRow = lastChanged;
                }

                if (nextLen < prevLen) {
                    for (let i = nextLen; i < prevLen; i++) {
                        buf += '\r\n\x1b[2K';
                    }
                    const backUp = prevLen - nextLen;
                    if (backUp > 0) buf += `\x1b[${backUp}A`;
                    this.cursorRow = Math.min(this.cursorRow, nextLen - 1);
                }
            }
        }

        buf += '\x1b[?2026l';
        if (cursorPos) {
            const targetRow = cursorPos.row;
            buf += `\x1b[${targetRow + 1};${cursorPos.col + 1}H`;
            buf += '\x1b[?25h';
            this.cursorRow = targetRow;
        } else {
            buf += '\x1b[?25l';
        }
        process.stdout.write(buf);
        this.prevLines = [...lines];
        this.lastFillRows = normalized.fillRows;
        this.lastWidth = width;
        this.lastHeight = height;
    }

    /**
     * 260703 F3 — DECSTBM ignores a 1-row region (`CSI 1;1r` is a silent
     * no-op on real terminals; empirically verified against @xterm/headless
     * in the jawcode sibling repo), so the LAST committed row could never be
     * scrolled out and the next diff overwrote it. Widen to [1..2] (count is
     * necessarily 1 — a 1-row region cannot owe more) and rotate the painted
     * mirror the same way the physical rows shift: row 2 moves up to row 1,
     * row 2 opens blank — the same-pass diff then maps every row correctly.
     */
    private buildShrinkScrollOut(count: number, regionBottom: number): string {
        if (count <= 0 || regionBottom < 1) return '';
        if (regionBottom > 1) {
            return buildScrollOutSequence(count, regionBottom, { row: this.cursorRow, col: 0 });
        }
        const out = buildScrollOutSequence(1, 2, { row: this.cursorRow, col: 0 });
        if (this.prevLines.length > 1) {
            this.prevLines[0] = this.prevLines[1] ?? '';
            this.prevLines[1] = '';
        }
        return out;
    }

    /**
     * The commit scroll pushes the top `count` rows of the 1..liveZoneTop
     * region into scrollback. Those rows must not hold last-frame pixels
     * (prevLines is the painted frame model; committed-lane residue is not in
     * it, fill rows read as ''). A fresh screen (nothing painted yet, e.g.
     * right after the launch clear in this same render pass) is blank.
     */
    private commitScrollOutRowsAreBlank(count: number, liveZoneTop: number): boolean {
        if (this.prevLines.length === 0) return true;
        const pushed = Math.min(count, liveZoneTop);
        for (let i = 0; i < pushed; i++) {
            const row = this.prevLines[i] ?? '';
            if (row.replace(/\x1b\[[0-9;]*m/g, '').trim() !== '') return false;
        }
        return true;
    }

    /** Returns true when the lines were accepted into the pending commit queue. */
    queueCommitLines(lines: string[]): boolean {
        if (!this.inlineActive || lines.length === 0) return false;
        if (this.needsResizeRepaint()) return false;
        if (detectHistoryLaneMode() !== 'standard') return false;
        const width = Math.max(1, process.stdout.columns || 80);
        this.pendingCommitLines.push(...lines.map(line => normalizeFrameRow(line, width)));
        return true;
    }

    lastCommitFlushedCount(): number {
        const n = this.lastFlushed;
        this.lastFlushed = 0;
        return n;
    }

    /** True when the last render deferred a flush because the scroll-out rows
     *  still held last-frame pixels — the one defer reason a retry resolves. */
    lastCommitDeferredByStaleRows(): boolean {
        return this.lastDeferredByStaleRows;
    }

    forceRedraw(): void {
        this.fullRedrawPending = true;
    }

    forceResizeRedraw(): void {
        this.fullRedrawPending = true;
        this.resizeRedrawPending = true;
    }

    resetViewport(): void {
        if (!this.inlineActive) return;
        let buf = '\x1b[?2026h';
        if (this.prevLines.length > 0) {
            if (this.cursorRow > 0) buf += `\x1b[${this.cursorRow}A`;
            buf += '\r';
            for (let i = 0; i < this.prevLines.length; i += 1) {
                if (i > 0) buf += '\x1b[1B\r';
                buf += '\x1b[2K';
            }
            if (this.prevLines.length > 1) buf += `\x1b[${this.prevLines.length - 1}A`;
            buf += '\r';
        }
        buf += '\x1b[?2026l';
        process.stdout.write(buf);
        this.prevLines = [];
        this.cursorRow = 0;
        this.lastFillRows = 0;
        this.committedScreenRows = 0;
        this.committedBottomRow = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = false;
        this.scrollbackProtected = false;
        this.fullRedrawPending = true;
        this.resizeRedrawPending = false;
    }

    enableMouse(): void {
        process.stdout.write('\x1b[?1000h\x1b[?1006h');
    }

    disableMouse(): void {
        process.stdout.write('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l');
    }

    private resizeRepaintMode(widthChanged: boolean, heightChanged: boolean): 'discard-scrollback' | 'visible-clear' | 'viewport-only' {
        if (!widthChanged && !heightChanged) return 'viewport-only';
        const mux = isMultiplexerSession();
        // 260703 F2: a resize before the first native commit may discard OUR
        // saved lines — but never a tmux/screen pane's history (same ownership
        // rule as the launch clear; cmux keeps the discard contract).
        if (!this.hasNativeCommit) return isForeignMultiplexer() ? 'visible-clear' : 'discard-scrollback';
        if (!mux) return 'visible-clear';
        return widthChanged ? 'visible-clear' : 'viewport-only';
    }
}

function buildViewportRepaintSequence(lines: string[], height: number): string {
    const repaintRows = Math.max(1, height);
    let out = '\x1b[H';
    for (let i = 0; i < repaintRows; i += 1) {
        if (i > 0) out += `\x1b[${i + 1};1H`;
        out += '\x1b[2K' + (lines[i] ?? '');
    }
    return out;
}

function buildFullClearSequence(includeSavedLines: boolean): string {
    return includeSavedLines ? '\x1b[2J\x1b[H\x1b[3J' : '\x1b[2J\x1b[H';
}

function buildLaunchClearSequence(): string {
    // 260703 F1: a tmux/screen pane's scrollback belongs to the USER —
    // launching jaw must not 3J it away. Plain terminals and first-party cmux
    // keep the fresh-terminal launch behavior (see isForeignMultiplexer).
    return buildFullClearSequence(!isForeignMultiplexer());
}

function isMultiplexerSession(env: Record<string, string | undefined> = process.env): boolean {
    const term = (env['TERM'] ?? '').toLowerCase();
    return Boolean(
        env['TMUX']
        || env['STY']
        || env['CMUX_WORKSPACE_ID']
        || env['CMUX_SURFACE_ID']
        || env['CMUX_SOCKET_PATH']
        || term.startsWith('tmux')
        || term.startsWith('screen')
    );
}

/**
 * 260703 F1/F2 — scrollback OWNERSHIP split: tmux/GNU-screen panes belong to
 * the USER (shared, navigable history), so jaw must never 3J them. cmux is
 * first-party: its panes are dedicated jaw surfaces and the existing contract
 * (launch/pre-commit resize clear "like a fresh terminal") stays.
 */
function isForeignMultiplexer(env: Record<string, string | undefined> = process.env): boolean {
    const term = (env['TERM'] ?? '').toLowerCase();
    return Boolean(env['TMUX'] || env['STY'] || term.startsWith('tmux') || term.startsWith('screen'));
}

function detectHistoryLaneMode(env: Record<string, string | undefined> = process.env): 'standard' | 'unsupported' {
    const term = (env['TERM'] ?? '').toLowerCase();
    if (env['ZELLIJ'] || env['ZELLIJ_SESSION_NAME']) return 'unsupported';
    if (term === 'dumb') return 'unsupported';
    return 'standard';
}


function buildScrollOutSequence(
    count: number,
    regionBottom: number,
    cursor: { row: number; col: number },
): string {
    if (count <= 0 || regionBottom < 1) return '';
    let out = '';
    out += `\x1b[1;${regionBottom}r`;
    out += `\x1b[${regionBottom};1H`;
    out += '\r\n'.repeat(count);
    out += '\x1b[r';
    out += `\x1b[${cursor.row + 1};${cursor.col + 1}H`;
    return out;
}

export function registerScreenCleanup(screen: Screen): void {
    const cleanup = () => {
        screen.disableMouse();
        screen.exit();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
}
