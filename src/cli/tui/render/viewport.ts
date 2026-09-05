/**
 * Virtualized transcript viewport for alt-screen mode (Phase 4).
 * Memoized: setItems() only re-renders cells whose content has changed.
 */
import type { TranscriptItem } from '../transcript.js';
import type { Rect } from './layout.js';
export interface CommitFrontier {
    preludeCommitted: boolean;
    itemIndex: number;
}

export interface ViewportCell {
    lines: string[];
    revision: number;
    cacheKey: string;
}

export class Viewport {
    private cells: ViewportCell[] = [];
    private preludeLines: string[] = [];
    private scrollTop = 0;
    private follow = true;
    private width = 80;
    private widthChanged = false;
    private frontier: CommitFrontier = { preludeCommitted: false, itemIndex: 0 };

    setWidth(cols: number): void {
        const next = Math.max(20, cols);
        if (next !== this.width) {
            this.width = next;
            this.widthChanged = true;
        }
    }

    setPrelude(lines: string[]): void {
        this.preludeLines = [...lines];
        this.clampFrontier();
    }

    setItems(items: TranscriptItem[], renderLine: (item: TranscriptItem, width: number) => string[], visibleRows = 1): void {
        if (this.widthChanged || this.cells.length === 0) {
            this.cells = items.map((item, i) => ({
                lines: renderLine(item, this.width),
                revision: i,
                cacheKey: this.itemCacheKey(item),
            }));
            this.widthChanged = false;
        } else {
            const prevLen = this.cells.length;
            const nextLen = items.length;
            const shared = Math.min(prevLen, nextLen);
            for (let i = 0; i < shared; i++) {
                const item = items[i]!;
                const key = this.itemCacheKey(item);
                const cell = this.cells[i]!;
                if (item.type === 'status' || cell.cacheKey !== key) {
                    cell.lines = renderLine(item, this.width);
                    cell.cacheKey = key;
                    cell.revision += 1;
                }
            }
            if (nextLen > prevLen) {
                for (let i = prevLen; i < nextLen; i++) {
                    this.cells.push({
                        lines: renderLine(items[i]!, this.width),
                        revision: i,
                        cacheKey: this.itemCacheKey(items[i]!),
                    });
                }
            } else if (nextLen < prevLen) {
                this.cells.length = nextLen;
            }
        }
        this.clampFrontier();
        if (this.follow) {
            if (items.length === 0 && this.hasUncommittedPrelude()) {
                this.scrollTop = 0;
            } else {
                this.scrollToBottom(visibleRows);
            }
        } else {
            this.clampScroll(visibleRows);
        }
    }

    updateTail(item: TranscriptItem, renderLine: (item: TranscriptItem, width: number) => string[], visibleRows = 1): void {
        if (!this.cells.length) {
            this.setItems([item], renderLine);
            return;
        }
        const tail = this.cells[this.cells.length - 1]!;
        tail.lines = renderLine(item, this.width);
        tail.revision += 1;
        tail.cacheKey = this.itemCacheKey(item);
        this.clampFrontier();
        if (this.follow) this.scrollToBottom(visibleRows);
    }

    appendCell(item: TranscriptItem, renderLine: (item: TranscriptItem, width: number) => string[], visibleRows = 1): void {
        this.cells.push({
            lines: renderLine(item, this.width),
            revision: this.cells.length,
            cacheKey: this.itemCacheKey(item),
        });
        this.clampFrontier();
        if (this.follow) this.scrollToBottom(visibleRows);
    }

    followTail(on: boolean, visibleRows = 1): void {
        this.follow = on;
        if (on) this.scrollToBottom(visibleRows);
    }

    scrollBy(lines: number, visibleRows = 1): void {
        this.follow = false;
        this.scrollTop = Math.max(0, this.scrollTop + lines);
        this.clampScroll(visibleRows);
    }

    pageUp(regionHeight: number): void { this.scrollBy(-Math.max(1, regionHeight - 1), regionHeight); }
    pageDown(regionHeight: number): void {
        this.scrollBy(Math.max(1, regionHeight - 1), regionHeight);
        const max = Math.max(0, this.totalLines() - regionHeight);
        if (this.scrollTop >= max) this.follow = true;
    }

    scrollToBottom(visibleRows = 1): void {
        this.follow = true;
        this.scrollTop = Math.max(0, this.totalLines() - visibleRows);
    }

    scrollToTop(): void {
        this.scrollTop = 0;
        this.follow = false;
    }

    isFollowingTail(): boolean {
        return this.follow;
    }

    hasUncommittedPreludeRows(): boolean {
        return !this.frontier.preludeCommitted && this.preludeLines.length > 0;
    }

    totalLines(): number {
        return this.visibleRows().length;
    }

    peekStableCommitRows(transcriptHeight: number, stablePrefixIndex: number): { rows: string[]; frontier: CommitFrontier } | null {
        if (!this.follow) return null;
        const flat = this.flattenRows();
        const visible = this.visibleRows();
        if (visible.length <= transcriptHeight) return null;

        const currentCommitted = this.committedLogicalRowCount();
        const safeUntil = Math.max(0, flat.length - Math.max(1, transcriptHeight));
        if (safeUntil <= currentCommitted) return null;

        const newFrontier: CommitFrontier = { ...this.frontier };
        let rowCursor = currentCommitted;

        if (!newFrontier.preludeCommitted && this.preludeLines.length > 0) {
            const end = this.preludeLines.length;
            // The flat row stream starts with the complete prelude. If it cannot
            // commit yet, counting item rows from zero would publish welcome
            // pixels but mark answers committed, hiding them without printing.
            if (end > safeUntil) return null;
            newFrontier.preludeCommitted = true;
            rowCursor = end;
        }

        const maxItem = Math.min(stablePrefixIndex, this.cells.length);
        for (let i = newFrontier.itemIndex; i < maxItem; i++) {
            const end = rowCursor + this.cells[i]!.lines.length;
            if (end > safeUntil) break;
            newFrontier.itemIndex = i + 1;
            rowCursor = end;
        }

        if (rowCursor <= currentCommitted) return null;
        return { rows: flat.slice(currentCommitted, rowCursor), frontier: newFrontier };
    }

    withPreviewFrontier(frontier: CommitFrontier): Viewport {
        const preview = Object.create(this) as Viewport;
        Object.defineProperty(preview, 'frontier', { value: { ...frontier }, writable: false });
        return preview;
    }

    markCommittedFrontier(frontier: CommitFrontier): void {
        this.frontier = { ...frontier };
        if (this.follow) this.scrollToBottom(1);
    }

    resetFrontier(): void {
        this.frontier = { preludeCommitted: false, itemIndex: 0 };
    }

    currentFrontier(): CommitFrontier {
        return { ...this.frontier };
    }

    composeRegion(region: Rect): string[] {
        const flat = this.visibleRows();
        this.clampScroll(region.height);
        if (this.follow && flat.length > 0 && flat.length < region.height) {
            if (this.hasUncommittedPreludeRows()) {
                return [
                    ...flat,
                    ...new Array(region.height - flat.length).fill(''),
                ];
            }
            return flat;
        }
        const start = this.scrollTop;
        const out: string[] = [];
        for (let i = 0; i < Math.min(region.height, flat.length - start); i++) {
            out.push(flat[start + i] ?? '');
        }
        return out;
    }

    private clampScroll(visibleRows = 1): void {
        const max = Math.max(0, this.totalLines() - visibleRows);
        if (this.scrollTop > max) this.scrollTop = max;
    }

    private clampFrontier(): void {
        if (this.frontier.itemIndex > this.cells.length)
            this.frontier.itemIndex = this.cells.length;
    }

    private committedLogicalRowCount(): number {
        let count = 0;
        if (this.frontier.preludeCommitted) count += this.preludeLines.length;
        for (let i = 0; i < this.frontier.itemIndex && i < this.cells.length; i++)
            count += this.cells[i]!.lines.length;
        return count;
    }

    private flattenRows(): string[] {
        const flat: string[] = [...this.preludeLines];
        for (const cell of this.cells) flat.push(...cell.lines);
        return flat;
    }

    private visibleRows(): string[] {
        const rows: string[] = [];
        if (!this.frontier.preludeCommitted) rows.push(...this.preludeLines);
        for (let i = 0; i < this.cells.length; i++) {
            if (i < this.frontier.itemIndex) continue;
            rows.push(...this.cells[i]!.lines);
        }
        return rows;
    }

    private hasUncommittedPrelude(): boolean {
        return !this.frontier.preludeCommitted && this.preludeLines.length > 0;
    }

    private itemCacheKey(item: TranscriptItem): string {
        switch (item.type) {
            case 'activity': return `activity|${item.key}|${item.revision}|${item.presentation}`;
            case 'user': return `u|${item.displayText.length}|${hashText(item.displayText)}|${item.agentId ?? ''}`;
            case 'assistant': return `a|${item.text.length}|${hashText(item.text)}|${item.streaming ? 1 : 0}|${item.agentId ?? ''}`;
            case 'thinking': return `h|${item.text.length}|${hashText(item.text)}|${item.streaming ? 1 : 0}|${item.collapsed ? 1 : 0}|${item.stepRef ?? ''}|${item.agentId ?? ''}`;
            case 'tool': return `t|${item.text.length}|${hashText(item.text)}|${item.collapsed ? 1 : 0}|${item.detail ? hashText(item.detail) : ''}|${item.status ?? ''}|${item.stepRef ?? ''}|${item.agentId ?? ''}`;
            case 'command': return `c|${item.text.length}|${hashText(item.text)}|${item.commandName ?? ''}|${typeof item.ok === 'boolean' ? Number(item.ok) : ''}`;
            case 'status': return `s|${item.text.length}|${hashText(item.text)}|${item.agentId ?? ''}`;
        }
    }
}

function hashText(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
