// ── Virtual Scroll ──
import { generateId } from './uuid.js';
// Activates at THRESHOLD messages to prevent DOM bloat
// Below threshold: standard DOM append (zero overhead)

const THRESHOLD = 80;
const BUFFER = 5;
const EST_HEIGHT = 80;

export interface VirtualItem {
    id: string;
    html: string;
    height: number;
}

export type LazyRenderCallback = (targets: HTMLElement[]) => void;

export class VirtualScroll {
    private items: VirtualItem[] = [];
    private container: HTMLElement;
    private spacerTop: HTMLDivElement;
    private spacerBottom: HTMLDivElement;
    private viewport: HTMLDivElement;
    private _active = false;
    private _totalHeight = 0;
    private rafId: number | null = null;
    private firstVisible = -1;
    private lastVisible = -1;

    // Prefix sum for O(log n) offset lookup
    private prefixHeights: number[] = [0];
    private prefixDirtyFrom = 0;

    // Spacing model — measured from rendered .msg margin-bottom
    private itemSpacing = 0;
    private containerPadTop = 0;
    private containerPadBottom = 0;

    onLazyRender: LazyRenderCallback | null = null;
    onPostRender: ((viewport: HTMLElement) => void) | null = null;

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        this.spacerTop = document.createElement('div');
        this.spacerTop.className = 'vs-spacer-top';
        this.spacerBottom = document.createElement('div');
        this.spacerBottom.className = 'vs-spacer-bottom';
        this.viewport = document.createElement('div');
        this.viewport.className = 'vs-viewport';
    }

    get active(): boolean { return this._active; }
    get count(): number { return this.items.length; }

    // ── Prefix sum helpers ──

    private markPrefixDirty(from: number): void {
        this.prefixDirtyFrom = Math.min(this.prefixDirtyFrom, Math.max(0, from));
    }

    private rebuildPrefixHeights(): void {
        const n = this.items.length;
        if (this.prefixHeights.length !== n + 1) {
            this.prefixHeights = new Array(n + 1).fill(0);
            this.prefixDirtyFrom = 0;
        }
        for (let i = this.prefixDirtyFrom; i < n; i++) {
            this.prefixHeights[i + 1] = this.prefixHeights[i] + this.items[i].height;
        }
        this.prefixDirtyFrom = n;
    }

    /** Raw cumulative height up to (but not including) index */
    private offsetForIndex(index: number): number {
        this.rebuildPrefixHeights();
        return this.prefixHeights[Math.max(0, Math.min(index, this.items.length))];
    }

    /** Effective offset including inter-item spacing (margin-bottom) */
    private effectiveOffset(index: number): number {
        return this.offsetForIndex(index) + index * this.itemSpacing;
    }

    /** Total effective height of all items with spacing */
    private totalEffectiveHeight(): number {
        const n = this.items.length;
        if (n === 0) return 0;
        return this.offsetForIndex(n) + (n - 1) * this.itemSpacing;
    }

    /** Spacer height needed after the last rendered item.
     *  Viewport DOM omits margin after its last child, so add the boundary gap
     *  back when there are still off-screen items below. */
    private bottomSpacerHeight(lastVisible: number): number {
        const remaining = this.totalEffectiveHeight() - this.effectiveOffset(lastVisible + 1);
        return remaining + (lastVisible < this.items.length - 1 ? this.itemSpacing : 0);
    }

    /** Binary search: find item index at given scroll offset */
    private indexForOffset(offset: number): number {
        this.rebuildPrefixHeights();
        const n = this.items.length;
        if (n === 0) return 0;
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            const effOff = this.prefixHeights[mid] + mid * this.itemSpacing;
            if (effOff <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    // ── Spacing model ──

    private refreshLayoutMetrics(): void {
        const containerStyle = getComputedStyle(this.container);
        this.containerPadTop = parseFloat(containerStyle.paddingTop) || 0;
        this.containerPadBottom = parseFloat(containerStyle.paddingBottom) || 0;
        const sample = this.viewport.querySelector<HTMLElement>('.msg');
        if (sample) {
            this.itemSpacing = parseFloat(getComputedStyle(sample).marginBottom) || 0;
        }
    }

    // ── Public API ──

    flushToDOM(): void {
        if (!this._active) return;
        this.container.classList.remove('vs-active');
        this.container.removeEventListener('scroll', this.scrollHandler);
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        this.container.innerHTML = this.items.map(it => it.html).join('');
        this._active = false;
        this.firstVisible = -1;
        this.lastVisible = -1;
        this.items = [];
        this._totalHeight = 0;
        this.prefixHeights = [0];
        this.prefixDirtyFrom = 0;
        this.itemSpacing = 0;
    }

    /** Bulk-load items. Call AFTER registering onLazyRender/onPostRender. */
    setItems(
        items: VirtualItem[],
        options?: { autoActivate?: boolean; toBottom?: boolean },
    ): void {
        this.items = items;
        this._totalHeight = items.reduce((sum, it) => sum + it.height, 0);
        this.prefixHeights = new Array(items.length + 1).fill(0);
        this.prefixDirtyFrom = 0;
        if (options?.autoActivate === false) return;
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(options?.toBottom ?? true);
        }
    }

    /** Seed measured heights before activation. */
    seedMeasuredHeights(startIndex: number, heights: number[]): void {
        for (let offset = 0; offset < heights.length; offset++) {
            const idx = startIndex + offset;
            const item = this.items[idx];
            if (!item) continue;
            const oldH = item.height;
            const nextH = heights[offset];
            if (oldH === nextH) continue;
            item.height = nextH;
            this._totalHeight += nextH - oldH;
            this.markPrefixDirty(idx);
        }
    }

    /** Activate if threshold met. */
    activateIfNeeded(toBottom = false): void {
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(toBottom);
        }
    }

    addItem(id: string, html: string): void {
        const item: VirtualItem = { id, html, height: EST_HEIGHT };
        this.items.push(item);
        this._totalHeight += EST_HEIGHT;
        this.markPrefixDirty(this.items.length - 1);
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(true);
        }
        if (this._active) {
            this.scheduleRender();
        }
    }

    appendLiveItem(div: HTMLElement): void {
        if (!this._active) return;
        const html = div.outerHTML;
        const id = generateId();
        const item: VirtualItem = { id, html, height: EST_HEIGHT };
        this.items.push(item);
        this._totalHeight += EST_HEIGHT;
        this.markPrefixDirty(this.items.length - 1);
        this.scrollToBottom();
    }

    updateItemHtml(idx: number, html: string): void {
        if (this.items[idx]) {
            this.items[idx].html = html;
        }
    }

    private scrollHandler = () => this.scheduleRender();

    private activate(toBottom = false): void {
        this._active = true;
        this._totalHeight = 0;
        const existing = this.container.querySelectorAll('.msg');
        existing.forEach((el, i) => {
            if (this.items[i]) {
                this.items[i].height = el.getBoundingClientRect().height;
            }
        });
        for (const item of this.items) {
            this._totalHeight += item.height;
        }
        this.prefixHeights = new Array(this.items.length + 1).fill(0);
        this.prefixDirtyFrom = 0;

        this.container.classList.add('vs-active');
        this.container.replaceChildren(this.spacerTop, this.viewport, this.spacerBottom);
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });

        if (toBottom) {
            const total = this.totalEffectiveHeight();
            this.spacerTop.style.height = `${total}px`;
            this.spacerBottom.style.height = '0px';
            this.container.scrollTop = this.container.scrollHeight;
            this.firstVisible = -1;
            this.lastVisible = -1;
        }
        this.render();
    }

    private scheduleRender(): void {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.render();
        });
    }

    private render(): void {
        this.refreshLayoutMetrics();
        const scrollTop = this.container.scrollTop;
        const viewHeight = this.container.clientHeight;
        const contentScrollTop = Math.max(0, scrollTop - this.containerPadTop);
        const contentViewHeight = Math.max(0, viewHeight - this.containerPadTop - this.containerPadBottom);

        const startIdx = this.indexForOffset(contentScrollTop);
        const first = Math.max(0, startIdx - BUFFER);

        let endIdx = startIdx;
        for (let i = startIdx; i < this.items.length; i++) {
            endIdx = i;
            if (this.effectiveOffset(i + 1) > contentScrollTop + contentViewHeight) break;
        }
        const last = Math.min(this.items.length - 1, endIdx + BUFFER);

        if (first === this.firstVisible && last === this.lastVisible) {
            // Still update spacers when heights changed (RC3)
            const topSpace = this.effectiveOffset(first);
            const botSpace = this.bottomSpacerHeight(last);
            this.spacerTop.style.height = `${topSpace}px`;
            this.spacerBottom.style.height = `${botSpace}px`;
            return;
        }
        this.firstVisible = first;
        this.lastVisible = last;

        // Build map of currently mounted items by vsIdx
        const mounted = new Map<number, HTMLElement>();
        for (const child of Array.from(this.viewport.children) as HTMLElement[]) {
            const idx = Number(child.dataset.vsIdx);
            if (!isNaN(idx)) mounted.set(idx, child);
        }

        for (const [idx, el] of mounted) {
            if (idx < first || idx > last) {
                el.remove();
                mounted.delete(idx);
            }
        }

        const ordered: HTMLElement[] = [];
        for (let i = first; i <= last; i++) {
            const existing = mounted.get(i);
            if (existing) {
                ordered.push(existing);
            } else {
                const item = this.items[i];
                const div = document.createElement('div');
                div.innerHTML = item.html;
                const el = div.firstElementChild as HTMLElement;
                if (el) {
                    el.dataset.vsIdx = String(i);
                    ordered.push(el);
                }
            }
        }

        let nodeRef = this.viewport.firstChild as HTMLElement | null;
        for (const el of ordered) {
            if (el !== nodeRef) {
                this.viewport.insertBefore(el, nodeRef);
            } else {
                nodeRef = nodeRef.nextSibling as HTMLElement | null;
            }
        }

        // Measure spacing from actual DOM AFTER mounting items
        this.refreshLayoutMetrics();

        // Compute spacers with correct spacing
        const topSpace = this.effectiveOffset(first);
        const botSpace = this.bottomSpacerHeight(last);
        this.spacerTop.style.height = `${topSpace}px`;
        this.spacerBottom.style.height = `${botSpace}px`;

        if (this.onLazyRender) {
            const lazyTargets = this.viewport.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        if (this.onPostRender) {
            this.onPostRender(this.viewport);
        }

        this.remeasureVisible();
    }

    private remeasureVisible(): void {
        const wasAtBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 80;

        const rects: { idx: number; newH: number }[] = [];
        this.viewport.querySelectorAll('[data-vs-idx]').forEach(el => {
            const idx = Number((el as HTMLElement).dataset.vsIdx);
            if (this.items[idx]) {
                rects.push({ idx, newH: el.getBoundingClientRect().height });
            }
        });
        let heightChanged = false;
        for (const { idx, newH } of rects) {
            const oldH = this.items[idx].height;
            if (oldH !== newH) {
                this.items[idx].height = newH;
                this._totalHeight += (newH - oldH);
                this.markPrefixDirty(idx);
                heightChanged = true;
            }
        }
        if (heightChanged && wasAtBottom) {
            this.scrollToBottom();
        }
    }

    /** Synchronous scroll — cancel pending RAF, update spacers, render directly */
    scrollToBottom(): void {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        const total = this.totalEffectiveHeight();
        this.spacerTop.style.height = `${total}px`;
        this.spacerBottom.style.height = '0px';
        this.container.scrollTop = this.container.scrollHeight;
        this.firstVisible = -1;
        this.lastVisible = -1;
        this.render();
    }

    clear(): void {
        this.items = [];
        this._totalHeight = 0;
        this.prefixHeights = [0];
        this.prefixDirtyFrom = 0;
        this.itemSpacing = 0;
        this.containerPadTop = 0;
        this.containerPadBottom = 0;
        if (this._active) {
            this.container.classList.remove('vs-active');
            this.container.removeEventListener('scroll', this.scrollHandler);
            this.viewport.innerHTML = '';
            this.spacerTop.style.height = '0';
            this.spacerBottom.style.height = '0';
            this.container.innerHTML = '';
        }
        this._active = false;
        this.firstVisible = -1;
        this.lastVisible = -1;
        this.onLazyRender = null;
        this.onPostRender = null;
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}

// Singleton instance
let instance: VirtualScroll | null = null;

export function getVirtualScroll(): VirtualScroll {
    if (!instance) {
        instance = new VirtualScroll('chatMessages');
    }
    return instance;
}

export { THRESHOLD as VS_THRESHOLD };
