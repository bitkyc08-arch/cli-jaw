// ── Virtual Scroll ──
import { generateId } from './uuid.js';
// Activates at THRESHOLD messages to prevent DOM bloat
// Below threshold: standard DOM append (zero overhead)

const THRESHOLD = 80;
const BUFFER = 5;
const EST_HEIGHT = 80;

interface ScrollAnchor {
    index: number;
    top: number;
}

export function computeAnchoredScrollTop(
    anchorTop: number,
    offsetWithinItem: number,
    containerPadTop: number,
    maxScrollTop: number,
): number {
    const nextScrollTop = containerPadTop + anchorTop + offsetWithinItem;
    return Math.max(0, Math.min(nextScrollTop, maxScrollTop));
}

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
    private rafId: number | null = null;
    private suppressScrollDepth = 0;
    private _remeasuring = false;
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

    /** Total effective height of all items with spacing.
     *  Every item has margin-bottom in CSS (.vs-active .msg), so N items
     *  produce N spacing gaps. This equals effectiveOffset(n). */
    private totalEffectiveHeight(): number {
        const n = this.items.length;
        if (n === 0) return 0;
        return this.effectiveOffset(n);
    }

    /** Spacer height below the last rendered item. */
    private bottomSpacerHeight(lastVisible: number): number {
        return Math.max(0, this.totalEffectiveHeight() - this.effectiveOffset(lastVisible + 1));
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
        const msgs = Array.from(this.viewport.querySelectorAll<HTMLElement>('.msg'));
        const sample = msgs[0] ?? null;
        if (sample) {
            const spacing = parseFloat(getComputedStyle(sample).marginBottom) || 0;
            if (spacing > 0) this.itemSpacing = spacing;
            return;
        }
        // Fallback: when the viewport currently contains no messages, probe the
        // active CSS rule directly instead of collapsing spacing to 0.
        if (this._active && this.viewport.isConnected) {
            const probe = document.createElement('div');
            probe.className = 'msg';
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            probe.style.pointerEvents = 'none';
            probe.textContent = ' ';
            this.viewport.appendChild(probe);
            const spacing = parseFloat(getComputedStyle(probe).marginBottom) || 0;
            probe.remove();
            if (spacing > 0) this.itemSpacing = spacing;
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
        this.markPrefixDirty(this.items.length - 1);
        // Don't force scroll here — let the ui.ts wrapper decide
        // based on userNearBottom state
        this.scheduleRender();
    }

    updateItemHtml(idx: number, html: string): void {
        if (this.items[idx]) {
            this.items[idx].html = html;
        }
    }

    private scrollHandler = () => {
        if (this.suppressScrollDepth > 0) return;
        this.scheduleRender();
    };

    private activate(toBottom = false): void {
        this._active = true;
        const existing = this.container.querySelectorAll('.msg');
        existing.forEach((el, i) => {
            if (this.items[i]) {
                this.items[i].height = el.getBoundingClientRect().height;
            }
        });
        this.prefixHeights = new Array(this.items.length + 1).fill(0);
        this.prefixDirtyFrom = 0;

        this.container.classList.add('vs-active');
        this.container.replaceChildren(this.spacerTop, this.viewport, this.spacerBottom);
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
        // Measure spacing AFTER .vs-active is applied so CSS margin-bottom is active
        this.refreshLayoutMetrics();

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
        const anchor = this.captureScrollAnchor();

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

        // Compute spacers with correct spacing.
        // When the visible range shifts, spacerTop can jump by hundreds of px
        // (because previously-measured items have heights ≠ EST_HEIGHT).
        // Compensate scrollTop by the delta so the viewport content stays put.
        const oldTopSpace = parseFloat(this.spacerTop.style.height) || 0;
        const topSpace = this.effectiveOffset(first);
        const botSpace = this.bottomSpacerHeight(last);
        const spacerDelta = topSpace - oldTopSpace;
        this.spacerTop.style.height = `${topSpace}px`;
        this.spacerBottom.style.height = `${botSpace}px`;
        if (Math.abs(spacerDelta) > 1) {
            this.suppressScrollDepth++;
            this.container.scrollTop += spacerDelta;
            requestAnimationFrame(() => { requestAnimationFrame(() => { this.suppressScrollDepth--; }); });
        }

        if (this.onLazyRender) {
            const lazyTargets = this.viewport.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        if (this.onPostRender) {
            this.onPostRender(this.viewport);
        }

        this.remeasureVisible(anchor);
    }

    private captureScrollAnchor(): ScrollAnchor | null {
        const containerRect = this.container.getBoundingClientRect();
        const visibleTop = containerRect.top + this.containerPadTop;
        const candidates = Array.from(this.viewport.querySelectorAll<HTMLElement>('[data-vs-idx]'));
        const anchorEl = candidates.find((el) => el.getBoundingClientRect().bottom > visibleTop) ?? candidates[0] ?? null;
        if (!anchorEl) return null;
        const index = Number(anchorEl.dataset.vsIdx);
        if (!Number.isFinite(index)) return null;
        return {
            index,
            top: anchorEl.getBoundingClientRect().top - containerRect.top,
        };
    }

    private applyCurrentSpacers(): void {
        if (this.firstVisible < 0 || this.lastVisible < 0 || this.items.length === 0) {
            this.spacerTop.style.height = '0px';
            this.spacerBottom.style.height = '0px';
            return;
        }
        const topSpace = this.effectiveOffset(this.firstVisible);
        const botSpace = this.bottomSpacerHeight(this.lastVisible);
        this.spacerTop.style.height = `${topSpace}px`;
        this.spacerBottom.style.height = `${botSpace}px`;
    }

    private restoreScrollAnchor(anchor: ScrollAnchor | null): void {
        if (!anchor) return;
        const containerRect = this.container.getBoundingClientRect();
        const anchorEl = this.viewport.querySelector<HTMLElement>(`[data-vs-idx="${anchor.index}"]`);
        if (!anchorEl) return;
        const currentTop = anchorEl.getBoundingClientRect().top - containerRect.top;
        const delta = currentTop - anchor.top;
        if (Math.abs(delta) <= 1) return;
        const maxScrollTop = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
        // Suppress the asynchronous scroll event that fires after programmatic
        // scrollTop changes. Cleared in a nested RAF so it outlives the browser's
        // "update the rendering" step where scroll events are dispatched.
        // Uses a depth counter so overlapping suppression windows are safe.
        this.suppressScrollDepth++;
        this.container.scrollTop = Math.max(0, Math.min(this.container.scrollTop + delta, maxScrollTop));
        requestAnimationFrame(() => { requestAnimationFrame(() => { this.suppressScrollDepth--; }); });
    }

    private remeasureVisible(anchor: ScrollAnchor | null): void {
        if (this._remeasuring) return;

        // Threshold must be small (< 1 wheel tick ≈ 30px on macOS) so that
        // a single trackpad/wheel scroll-up escapes the "stick to bottom" zone.
        const wasAtBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 5;

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
                this.markPrefixDirty(idx);
                heightChanged = true;
            }
        }
        if (!heightChanged) return;

        this._remeasuring = true;
        try {
            this.applyCurrentSpacers();
            if (wasAtBottom) {
                this.scrollToBottom();
                return;
            }
            this.restoreScrollAnchor(anchor);
        } finally {
            this._remeasuring = false;
        }
    }

    /** Synchronous scroll — cancel pending RAF, update spacers, render directly */
    scrollToBottom(): void {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        const total = this.totalEffectiveHeight();
        this.spacerTop.style.height = `${total}px`;
        this.spacerBottom.style.height = '0px';
        this.suppressScrollDepth++;
        this.container.scrollTop = this.container.scrollHeight;
        requestAnimationFrame(() => { requestAnimationFrame(() => { this.suppressScrollDepth--; }); });
        this.firstVisible = -1;
        this.lastVisible = -1;
        this.render();
    }

    clear(): void {
        this.items = [];
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
