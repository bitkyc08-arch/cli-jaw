// ── Virtual Scroll (TanStack Virtual Core) ──
import {
    Virtualizer,
    elementScroll,
    observeElementRect,
    observeElementOffset,
} from '@tanstack/virtual-core';
import { generateId } from './uuid.js';

// Activates at THRESHOLD messages to prevent DOM bloat
// Activate immediately — tanstack virtualizes DOM so only visible
// items are rendered, preventing DOM bloat at any message count
const THRESHOLD = 1;
const EST_HEIGHT = 80;
const OVERSCAN = 5;

export interface VirtualItem {
    id: string;
    html: string;
    height: number; // used as estimateSize hint; tanstack measures real heights
}

export type LazyRenderCallback = (targets: HTMLElement[]) => void;

export class VirtualScroll {
    private items: VirtualItem[] = [];
    private container: HTMLElement;
    private innerEl: HTMLDivElement;
    private _active = false;
    private virtualizer: Virtualizer<HTMLElement, HTMLElement> | null = null;
    private cleanupFn: (() => void) | null = null;
    private mounted = new Map<number, HTMLElement>();
    private itemGap = 0;

    onLazyRender: LazyRenderCallback | null = null;
    onPostRender: ((viewport: HTMLElement) => void) | null = null;

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        this.innerEl = document.createElement('div');
        this.innerEl.className = 'vs-inner';
    }

    get active(): boolean { return this._active; }
    get count(): number { return this.items.length; }

    // ── Measure gap from CSS ──

    private measureGap(): number {
        if (this.itemGap > 0) return this.itemGap;
        const probe = document.createElement('div');
        probe.className = 'msg';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.textContent = ' ';
        this.innerEl.appendChild(probe);
        this.itemGap = parseFloat(getComputedStyle(probe).marginBottom) || 0;
        probe.remove();
        return this.itemGap;
    }

    // ── Public API (preserved for callers) ──

    /** Bulk-load items. Call AFTER registering onLazyRender/onPostRender. */
    setItems(
        items: VirtualItem[],
        options?: { autoActivate?: boolean; toBottom?: boolean },
    ): void {
        this.items = items;
        if (options?.autoActivate === false) return;
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(options?.toBottom ?? true);
        }
    }

    /** Seed heights into items so estimateSize returns accurate values.
     *  tanstack will re-measure via ResizeObserver on mount, but seeding
     *  gives accurate initial getTotalSize() for scrollToIndex precision. */
    seedMeasuredHeights(startIndex: number, heights: number[]): void {
        for (let offset = 0; offset < heights.length; offset++) {
            const idx = startIndex + offset;
            if (this.items[idx]) {
                this.items[idx].height = heights[offset];
            }
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
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(true);
            return;
        }
        if (this._active && this.virtualizer) {
            this.virtualizer.setOptions({
                ...this.virtualizer.options,
                count: this.items.length,
            });
        }
    }

    appendLiveItem(div: HTMLElement): void {
        if (!this._active) return;
        const html = div.outerHTML;
        const id = generateId();
        this.items.push({ id, html, height: EST_HEIGHT });
        if (this.virtualizer) {
            this.virtualizer.setOptions({
                ...this.virtualizer.options,
                count: this.items.length,
            });
        }
    }

    updateItemHtml(idx: number, html: string): void {
        if (this.items[idx]) {
            this.items[idx].html = html;
        }
    }

    scrollToBottom(): void {
        // Single source: DOM scrollTop only.
        // tanstack picks up the new position via its scroll event listener
        // (1 frame delay — fine for ongoing streaming/chat).
        // This also reaches streaming placeholder content that lives
        // outside VS as a direct container child.
        // Note: activate(toBottom) uses scrollToIndex for immediate sync.
        this.container.scrollTop = this.container.scrollHeight;
    }

    flushToDOM(): void {
        if (!this._active) return;
        this.deactivate();
        this.container.innerHTML = this.items.map(it => it.html).join('');
        this.items = [];
    }

    clear(): void {
        this.deactivate();
        this.items = [];
        this.itemGap = 0;
        this.onLazyRender = null;
        this.onPostRender = null;
    }

    // ── Activation / Deactivation ──

    private activate(toBottom = false): void {
        this._active = true;

        // Measure real heights from existing DOM before replacing
        const existing = this.container.querySelectorAll('.msg');
        existing.forEach((el, i) => {
            if (this.items[i]) {
                this.items[i].height = el.getBoundingClientRect().height;
            }
        });

        this.container.classList.add('vs-active');
        this.container.replaceChildren(this.innerEl);

        // Measure gap after .vs-active is applied
        this.measureGap();

        this.virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
            count: this.items.length,
            getScrollElement: () => this.container,
            estimateSize: (i: number) => this.items[i]?.height ?? EST_HEIGHT,
            overscan: OVERSCAN,
            gap: this.itemGap,
            // Our post-render pipeline mutates the mounted message DOM
            // (markdown lazy render, widgets, linkification). Defer RO-driven
            // measurements by one frame to avoid "ResizeObserver loop completed
            // with undelivered notifications" during those mutations.
            useAnimationFrameWithResizeObserver: true,
            onChange: () => this.renderItems(),
            observeElementRect,
            observeElementOffset,
            scrollToFn: elementScroll,
            getItemKey: (i: number) => this.items[i]?.id ?? i,
            indexAttribute: 'data-vs-idx',
        });

        this.cleanupFn = this.virtualizer._didMount();
        this.virtualizer._willUpdate();

        if (toBottom && this.items.length > 0) {
            // Hide during initial settle — scrollToIndex reconciliation
            // takes 1-2 RAF frames to converge
            this.container.style.opacity = '0';
            this.renderItems();
            // Use TanStack API — sets internal scrollState + DOM scrollTop
            // together, then reconciliation loop auto-corrects as items
            // get measured with real heights
            this.virtualizer.scrollToIndex(this.items.length - 1, { align: 'end' });
            // Show after reconciliation settles
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.container.style.opacity = '';
                });
            });
        } else {
            this.renderItems();
        }
    }

    private deactivate(): void {
        if (this.cleanupFn) {
            this.cleanupFn();
            this.cleanupFn = null;
        }
        this.virtualizer = null;
        this._active = false;
        this.mounted.clear();
        this.container.classList.remove('vs-active');
        this.container.innerHTML = '';
    }

    // ── Render loop (called by tanstack onChange) ──

    private renderItems(): void {
        if (!this.virtualizer) return;
        this.virtualizer._willUpdate();

        const virtualItems = this.virtualizer.getVirtualItems();
        const totalSize = this.virtualizer.getTotalSize();

        // Update inner container height (provides scrollbar range)
        this.innerEl.style.height = `${totalSize}px`;

        // Determine which indices tanstack wants rendered
        const wantedSet = new Set(virtualItems.map(vi => vi.index));

        // Remove items no longer in range
        for (const [idx, el] of this.mounted) {
            if (!wantedSet.has(idx)) {
                el.remove();
                this.mounted.delete(idx);
            }
        }

        // Mount / reposition items
        const newlyMounted: HTMLElement[] = [];
        for (const vItem of virtualItems) {
            let el = this.mounted.get(vItem.index);

            if (!el) {
                // Create new element from stored HTML
                const item = this.items[vItem.index];
                if (!item) continue;
                const wrapper = document.createElement('div');
                wrapper.innerHTML = item.html;
                el = wrapper.firstElementChild as HTMLElement;
                if (!el) continue;
                el.dataset.vsIdx = String(vItem.index);
                this.innerEl.appendChild(el);
                this.mounted.set(vItem.index, el);
                newlyMounted.push(el);
            }

            // Position via transform only — left/right/width handled by CSS
            // so .msg-user align-self / left:auto works correctly
            el.style.transform = `translateY(${vItem.start}px)`;
        }

        // Let tanstack measure real heights via ResizeObserver —
        // only for newly mounted elements (already-observed ones are tracked)
        for (const el of newlyMounted) {
            this.virtualizer!.measureElement(el);
        }

        // Lazy render: process any lazy-pending elements
        if (this.onLazyRender) {
            const lazyTargets = this.innerEl.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        // Post render: activate widgets, linkify paths
        if (this.onPostRender) {
            this.onPostRender(this.innerEl);
        }
    }
}

// ── Singleton ──

let instance: VirtualScroll | null = null;

export function getVirtualScroll(): VirtualScroll {
    if (!instance) {
        instance = new VirtualScroll('chatMessages');
    }
    return instance;
}

// ── Compat exports ──

/** @deprecated Kept for test compat — tanstack handles anchoring internally */
export function computeAnchoredScrollTop(
    anchorTop: number,
    offsetWithinItem: number,
    containerPadTop: number,
    maxScrollTop: number,
): number {
    const nextScrollTop = containerPadTop + anchorTop + offsetWithinItem;
    return Math.max(0, Math.min(nextScrollTop, maxScrollTop));
}

export { THRESHOLD as VS_THRESHOLD };
