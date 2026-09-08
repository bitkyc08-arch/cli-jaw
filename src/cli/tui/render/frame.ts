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
    /**
     * The committed block is top-anchored at the scrollback seam on rows
     * 1..B. This count is
     * the block geometry: content-only rows, never a blank above or inside.
     * The old bottom-anchored lane (block parked at the fill bottom under
     * blank rows, tracked via committedBottomRow) was retired upstream after
     * every blank-gap regression traced back to its region-top blanks.
     */
    private committedScreenRows = 0;
    private lastWidth = 0;
    private lastHeight = 0;
    private launchClearPending = false;
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
        this.committedScreenRows = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = true;
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
        this.committedScreenRows = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = false;
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
            this.launchClearPending = false;
        }

        // Flush pending scrollback commits. The committed block is
        // top-anchored at the
        // scrollback seam at rows 1..B. Commits either write DIRECTLY into the
        // blank fill row below the block (no scroll — blanks never move, so no
        // blank can ever cross the seam) or, once the block saturates the
        // fill, scroll region 1..B up by one so the OLDEST committed row
        // (content, never blank) enters the scrollback and the new line lands
        // on the freed bottom row. This retires the bottom-anchored insert
        // geometry whose region-top blank rows stamped the blank bands into
        // history (user repro 260704).
        // Deferred when the direct-write target rows still hold pixels from
        // the previous frame layout (e.g. the launch-anchored welcome on the
        // frame that releases the anchor): the flush runs BEFORE the diff
        // repaint, and the diff would 2K our fresh committed rows (model says
        // those rows are blank fill). Skipping leaves the frontier unadvanced;
        // the scheduler re-queues the same commit next frame, after the
        // repaint blanked the region. (Physical committed-lane residue at rows
        // 1..B is invisible to prevLines — fill rows stay '' in the frame
        // model — so residue is never re-diffed.)
        this.lastFlushed = 0;
        this.lastDeferredByStaleRows = false;
        const fillRows = Math.min(normalized.fillRows, height);
        const blockRows = Math.min(this.committedScreenRows, fillRows);
        if (this.pendingCommitLines.length > 0 && fillRows >= 2
            && !this.commitTargetRowsAreBlank(this.pendingCommitLines.length, blockRows, fillRows)) {
            // Defer: the repaint below blanks the region; the caller may retry
            // next frame (this is the only defer reason worth a retry — other
            // skips are geometry/lane constraints that a retry cannot change).
            this.lastDeferredByStaleRows = true;
        }
        if (this.pendingCommitLines.length > 0 && fillRows >= 2 && !this.lastDeferredByStaleRows) {
            let b = blockRows;
            for (const line of this.pendingCommitLines) {
                if (b < fillRows) {
                    // Blank fill row below the block: write in place, no scroll.
                    buf += `\x1b[${b + 1};1H\x1b[2K` + line;
                    b++;
                } else {
                    // Saturated: rows 1..B are all content — scroll the oldest
                    // row across the seam, write on the freed bottom row.
                    buf += `\x1b[1;${b}r\x1b[${b};1H\r\n\x1b[2K` + line + '\x1b[r';
                }
            }
            buf += '\x1b[H';
            this.cursorRow = 0;
            this.committedScreenRows = b;
            this.lastFlushed = this.pendingCommitLines.length;
            this.hasNativeCommit = true;
        }
        this.pendingCommitLines = [];

        if (!this.resizeRedrawPending && this.committedScreenRows > 0) {
            // 260704 WP6b-v2: the committed block is top-anchored at rows 1..B
            // (content-only, no blanks above by construction). When the fill
            // drops below B, the overflow scrolls out through the region top —
            // only committed content ever crosses the seam.
            const historyBottom = Math.min(this.committedScreenRows, height);
            if (normalized.fillRows < historyBottom) {
                const shrink = historyBottom - normalized.fillRows;
                buf += this.buildShrinkScrollOut(shrink, historyBottom);
                this.committedScreenRows = Math.min(this.committedScreenRows, normalized.fillRows);
            }
        }

        if (this.resizeRedrawPending) {
            const mode = this.resizeRepaintMode(widthChanged, heightChanged);
            // 260704 WP6b-v2: any repaint below rewrites rows 1..height with
            // frame content (blank fill over the block's rows), so the
            // top-anchored committed block must cross the seam FIRST —
            // content-only, region [1..B]; no blank can precede it. The old
            // geometry pushed the whole [1..fillBottom] region here, stamping
            // the blank rows above the parked block into scrollback on every
            // resize (blank-band user repro 260704); viewport-only repaints
            // erased the block outright without flushing it (content loss).
            if (this.committedScreenRows > 0) {
                let flushRows = Math.min(this.committedScreenRows, height);
                // On a height shrink outside a multiplexer, the terminal has
                // ALREADY pushed the top (oldHeight − newHeight) rows into its
                // scrollback (cursor-anchored shrink) — under the top-anchored
                // geometry those are exactly the oldest committed rows, in
                // order. ADOPT them instead of re-emitting a second copy
                // (the observed failure was partial `╭─ You` copies after a
                // window shrink).
                // Width changes don't gate this: the push is a height effect
                // (adversarial finding 1 — width+height shrink duplicated the
                // block AND stamped trailing blanks). The NET height delta is
                // the right count even across coalesced shrink→grow events:
                // mainstream terminals PULL rows back from scrollback on grow,
                // so only the net-shrunk rows remain pushed.
                if (heightChanged && !isMultiplexerSession()
                    && this.lastHeight > 0 && height < this.lastHeight) {
                    flushRows = Math.max(0, flushRows - (this.lastHeight - height));
                }
                if (flushRows > 0) buf += this.buildShrinkScrollOut(flushRows, flushRows);
                this.committedScreenRows = 0;
            }
            if (mode !== 'viewport-only') {
                buf += buildFullClearSequence(mode === 'discard-scrollback');
            }
            buf += buildViewportRepaintSequence(lines, height);
            this.cursorRow = Math.max(0, Math.min(lines.length, height) - 1);
            this.fullRedrawPending = false;
            this.resizeRedrawPending = false;
        } else if (this.fullRedrawPending || this.prevLines.length === 0) {
            if (this.fullRedrawPending && this.committedScreenRows > 0) {
                const flushRows = Math.min(this.committedScreenRows, height);
                buf += this.buildShrinkScrollOut(flushRows, flushRows);
                this.committedScreenRows = 0;
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
        this.lastWidth = width;
        this.lastHeight = height;
    }

    /**
     * 260703 F3 — DECSTBM ignores a 1-row region (`CSI 1;1r` is a silent
     * no-op on real terminals and @xterm/headless), so the last committed row
     * could never be
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
     * The commit flush writes directly into rows [fromRow+1 .. fromRow+count]
     * (1-based; capped at the fill bottom). Those target rows must not hold
     * last-frame pixels (prevLines is the painted frame model; committed-lane
     * residue at rows 1..B is not in it, fill rows read as '') — the diff pass
     * after the flush would 2K a fresh committed row wherever the model still
     * shows previous-frame content. A fresh screen (nothing painted yet, e.g.
     * right after the launch clear in this same render pass) is blank.
     */
    private commitTargetRowsAreBlank(count: number, fromRow: number, fillRows: number): boolean {
        if (this.prevLines.length === 0) return true;
        const end = Math.min(fromRow + count, fillRows);
        for (let i = fromRow; i < end; i++) {
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
        // No fill-capacity preflight here (adversarial finding 3, assessed
        // benign): when the fill lane is under 2 rows the render skips the
        // flush and the frontier stays unmarked, so the caller re-derives the
        // same rows next frame. The preview-hidden rows are exactly the rows
        // beyond the visible window (peekStableCommitRows only commits the
        // overflow), and scroll-up renders through the REAL viewport — so the
        // one-frame optimistic hide is never user-visible. A capacity check
        // against the LAST frame's fill would wrongly refuse the anchor-release
        // commit, whose previous frame legitimately has fillRows = 0.
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
        // The erase loop below wipes every physical row — the top-anchored
        // committed block at rows 1..B must cross the seam first (content-only)
        // or its pixels evaporate without ever reaching the scrollback.
        if (this.committedScreenRows > 0) {
            const flushRows = Math.min(this.committedScreenRows, process.stdout.rows || 24);
            buf += this.buildShrinkScrollOut(flushRows, flushRows);
        }
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
        this.committedScreenRows = 0;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this.launchClearPending = false;
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
