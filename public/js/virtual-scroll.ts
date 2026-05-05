// ── Virtual Scroll (TanStack Virtual Core) ──
import {
    Virtualizer,
    elementScroll,
    observeElementRect,
    observeElementOffset,
} from '@tanstack/virtual-core';
import { generateId } from './uuid.js';
import { releaseMermaidNodes } from './render.js';
import { releaseProcessBlockDetails } from './features/process-block.js';

// Activate immediately: tanstack keeps only visible items mounted.
const THRESHOLD = 1;
const EST_HEIGHT = 80;
const OVERSCAN = 5;
const BOTTOM_THRESHOLD = 80;

export type RestoreReason =
    | 'pageshow'
    | 'visibility'
    | 'focus'
    | 'pagehide'
    | 'freeze'
    | 'resume'
    | 'discard'
    | 'reconnect'
    | 'manual';

export interface VirtualItem {
    id: string;
    html: string;
    height: number; // used as estimateSize hint; tanstack measures real heights
    rehydratesProcessDetails?: boolean;
}

export type LazyRenderCallback = (targets: HTMLElement[]) => void;
type MeasurableVirtualElement = Pick<HTMLElement, 'getBoundingClientRect'>;

function readMeasuredHeight(el: MeasurableVirtualElement): number {
    const height = Math.ceil(el.getBoundingClientRect().height);
    return Number.isFinite(height) && height > 0 ? height : 0;
}

export function syncMeasuredItemHeight(
    items: VirtualItem[],
    index: number,
    el: MeasurableVirtualElement,
): void {
    if (!items[index]) return;
    const height = readMeasuredHeight(el);
    if (height > 0) items[index].height = height;
}

export function remeasureMountedVirtualItems(
    items: VirtualItem[],
    mounted: Map<number, MeasurableVirtualElement>,
    virtualizer: Pick<Virtualizer<HTMLElement, HTMLElement>, 'measureElement'> | null,
): void {
    if (!virtualizer) return;
    for (const [index, el] of mounted) {
        syncMeasuredItemHeight(items, index, el);
        virtualizer.measureElement(el as HTMLElement);
    }
}

export class VirtualScroll {
    private items: VirtualItem[] = [];
    private container: HTMLElement;
    private innerEl: HTMLDivElement;
    private _active = false;
    private virtualizer: Virtualizer<HTMLElement, HTMLElement> | null = null;
    private cleanupFn: (() => void) | null = null;
    private mounted = new Map<number, HTMLElement>();
    private itemGap = 0;
    private restorePassTimers = new Set<number>();

    onLazyRender: LazyRenderCallback | null = null;
    onPostRender: ((viewport: HTMLElement) => void) | null = null;

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        this.innerEl = document.createElement('div');
        this.innerEl.className = 'vs-inner';
    }

    get active(): boolean { return this._active; }
    get count(): number { return this.items.length; }

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

    private invalidateLayout(): void {
        if (!this.virtualizer) return;
        this.itemGap = 0;
        const newGap = this.measureGap();
        this.virtualizer.setOptions({
            ...this.virtualizer.options,
            gap: newGap,
        });
        this.virtualizer.measure();
        remeasureMountedVirtualItems(this.items, this.mounted, this.virtualizer);
        this.renderItems();
    }

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

    /** Seed heights so estimateSize is accurate before ResizeObserver runs. */
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
        this.appendItem({ id, html, height: EST_HEIGHT });
    }

    appendItem(item: VirtualItem): void {
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
        releaseMermaidNodes(div);
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
        if (this._active && this.virtualizer && this.items.length > 0) {
            this.virtualizer.scrollToIndex(this.items.length - 1, { align: 'end' });
        }
        // Keep DOM scrollTop as the final source so streaming placeholder
        // content outside VS is still reachable.
        this.container.scrollTop = this.container.scrollHeight;
    }

    isNearBottom(threshold = BOTTOM_THRESHOLD): boolean {
        const dist = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
        return dist < threshold;
    }

    reconcileBottomAfterLayout(reason: RestoreReason, shouldFollow = this.isNearBottom()): void {
        if (!shouldFollow) return;
        void reason;
        requestAnimationFrame(() => {
            this.invalidateLayout();
            requestAnimationFrame(() => {
                this.scrollToBottom();
            });
        });
    }

    forceBottomAfterRestore(reason: RestoreReason): void {
        this.scheduleRestoreReconcile(reason);
    }

    private scheduleRestoreReconcile(reason: RestoreReason): void {
        this.runRestoreReconcilePass(reason);
        requestAnimationFrame(() => this.runRestoreReconcilePass(reason));
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this.runRestoreReconcilePass(reason));
        });
        this.scheduleRestoreTimer(reason, 250);
        this.scheduleRestoreTimer(reason, 1000);
        void document.fonts?.ready.then(() => this.runRestoreReconcilePass(reason));
    }

    private scheduleRestoreTimer(reason: RestoreReason, delayMs: number): void {
        const timer = window.setTimeout(() => {
            this.restorePassTimers.delete(timer);
            this.runRestoreReconcilePass(reason);
        }, delayMs);
        this.restorePassTimers.add(timer);
    }

    private runRestoreReconcilePass(reason: RestoreReason): void {
        if (!this.virtualizer) return;
        void reason;
        this.invalidateLayout();
        remeasureMountedVirtualItems(this.items, this.mounted, this.virtualizer);
        this.scrollToBottom();
    }

    private clearRestoreTimers(): void {
        for (const timer of this.restorePassTimers) {
            window.clearTimeout(timer);
        }
        this.restorePassTimers.clear();
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

        const cleanupFns: Array<() => void> = [];
        const mountCleanup = this.virtualizer._didMount();
        if (mountCleanup) cleanupFns.push(mountCleanup);

        // ── Resize invalidation ──
        // When viewport width changes, message text reflows and heights change.
        // TanStack's ResizeObserver watches individual items, but not the
        // container width — a window resize doesn't trigger item RO callbacks
        // because items are position:absolute (width from left:0 + right:0).
        let resizeRaf = 0;
        const scheduleInvalidateLayout = () => {
            cancelAnimationFrame(resizeRaf);
            resizeRaf = requestAnimationFrame(() => {
                this.invalidateLayout();
            });
        };
        const onResize = () => scheduleInvalidateLayout();
        window.addEventListener('resize', onResize);
        cleanupFns.push(() => {
            window.removeEventListener('resize', onResize);
            cancelAnimationFrame(resizeRaf);
        });

        if (typeof ResizeObserver !== 'undefined') {
            let prevWidth = this.container.clientWidth;
            let prevHeight = this.container.clientHeight;
            const containerObserver = new ResizeObserver((entries) => {
                const rect = entries[0]?.contentRect;
                if (!rect) return;
                const width = Math.round(rect.width);
                const height = Math.round(rect.height);
                if (width === prevWidth && height === prevHeight) return;
                prevWidth = width;
                prevHeight = height;
                scheduleInvalidateLayout();
            });
            containerObserver.observe(this.container);
            cleanupFns.push(() => containerObserver.disconnect());
        }

        // ── Browser restore reconciliation ──
        // Resume/discard paths can restore stale virtualizer measurements.
        // Product policy: browser restore/reconnect forces the newest message.
        const restoreBottomAfterLayout = (reason: RestoreReason) => {
            if (!this.virtualizer) return;
            this.forceBottomAfterRestore(reason);
        };
        const onPageShow = (e: PageTransitionEvent) => {
            if (!e.persisted) return;
            restoreBottomAfterLayout('pageshow');
        };
        window.addEventListener('pageshow', onPageShow);
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            restoreBottomAfterLayout('visibility');
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        const onFocus = () => restoreBottomAfterLayout('focus');
        window.addEventListener('focus', onFocus);
        const onResume = () => restoreBottomAfterLayout('resume');
        document.addEventListener('resume', onResume);
        const onPageHide = () => { /* diagnostic hook: restore happens on pageshow/resume */ };
        window.addEventListener('pagehide', onPageHide);
        const onFreeze = () => { /* diagnostic hook: restore happens on resume */ };
        document.addEventListener('freeze', onFreeze);
        this.cleanupFn = () => {
            window.removeEventListener('pageshow', onPageShow);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('resume', onResume);
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('freeze', onFreeze);
            for (const cleanup of cleanupFns.reverse()) cleanup();
            this.clearRestoreTimers();
        };

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
        const wasDiscarded = 'wasDiscarded' in document
            && Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded);
        if (wasDiscarded) {
            this.forceBottomAfterRestore('discard');
        }
    }

    private deactivate(): void {
        this.clearRestoreTimers();
        if (this.cleanupFn) {
            this.cleanupFn();
            this.cleanupFn = null;
        }
        this.virtualizer = null;
        this._active = false;
        for (const el of this.mounted.values()) {
            releaseMermaidNodes(el);
            releaseProcessBlockDetails(el);
        }
        this.mounted.clear();
        this.container.classList.remove('vs-active');
        this.container.innerHTML = '';
    }

    private renderItems(): void {
        if (!this.virtualizer) return;
        this.virtualizer._willUpdate();

        const virtualItems = this.virtualizer.getVirtualItems();
        const totalSize = this.virtualizer.getTotalSize();

        this.innerEl.style.height = `${totalSize}px`;

        const wantedSet = new Set(virtualItems.map(vi => vi.index));

        for (const [idx, el] of this.mounted) {
            if (!wantedSet.has(idx)) {
                releaseMermaidNodes(el);
                const item = this.items[idx];
                if (item?.rehydratesProcessDetails) releaseProcessBlockDetails(el);
                el.remove();
                this.mounted.delete(idx);
            }
        }

        const newlyMounted: HTMLElement[] = [];
        for (const vItem of virtualItems) {
            let el = this.mounted.get(vItem.index);

            if (!el) {
                const item = this.items[vItem.index];
                if (!item) continue;
                const wrapper = document.createElement('div');
                wrapper.innerHTML = item.html;
                el = wrapper.firstElementChild as HTMLElement;
                if (!el) continue;
                el.dataset['vsIdx'] = String(vItem.index);
                this.innerEl.appendChild(el);
                this.mounted.set(vItem.index, el);
                newlyMounted.push(el);
            }

            // CSS owns left/right/width, including .msg-user alignment.
            el.style.transform = `translateY(${vItem.start}px)`;
        }

        // Lazy render before measuring; markdown/code/math change heights.
        if (this.onLazyRender) {
            const lazyTargets = this.innerEl.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        if (this.onPostRender) {
            this.onPostRender(this.innerEl);
        }

        // Newly mounted elements now have their final rendered content.
        for (const el of newlyMounted) {
            const index = Number(el.dataset['vsIdx'] || '-1');
            syncMeasuredItemHeight(this.items, index, el);
            this.virtualizer!.measureElement(el);
        }
    }
}

let instance: VirtualScroll | null = null;

export function getVirtualScroll(): VirtualScroll {
    if (!instance) {
        instance = new VirtualScroll('chatMessages');
    }
    return instance;
}

export { THRESHOLD as VS_THRESHOLD };
