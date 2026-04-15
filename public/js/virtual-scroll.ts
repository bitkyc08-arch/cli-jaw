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

    /** Called after render() mounts items in viewport — for lazy rendering and widget activation */
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

    /** Flush all virtual items to real DOM and deactivate VS.
     *  Called on conversation clear or explicit reset. */
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
    }

    /** Bulk-load items without triggering activate mid-loop (RC5 fix).
     *  Call this AFTER registering onLazyRender/onPostRender. */
    setItems(items: VirtualItem[]): void {
        this.items = items;
        this._totalHeight = items.reduce((sum, it) => sum + it.height, 0);
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(true);
        }
    }

    addItem(id: string, html: string): void {
        const item: VirtualItem = { id, html, height: EST_HEIGHT };
        this.items.push(item);
        this._totalHeight += EST_HEIGHT;
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(true);
        }
        if (this._active) {
            this.scheduleRender();
        }
    }

    /** Append a live DOM element while keeping VS active.
     *  Serializes to HTML for virtual storage. */
    appendLiveItem(div: HTMLElement): void {
        if (!this._active) return;
        const html = div.outerHTML;
        const id = generateId();
        const item: VirtualItem = { id, html, height: EST_HEIGHT };
        this.items.push(item);
        this._totalHeight += EST_HEIGHT;
        // RC7 fix: use synchronous scrollToBottom (which handles spacers + render)
        this.scrollToBottom();
    }

    /** Update cached HTML for a specific item index (used by lazy render). */
    updateItemHtml(idx: number, html: string): void {
        if (this.items[idx]) {
            this.items[idx].html = html;
        }
    }

    private scrollHandler = () => this.scheduleRender();

    /** RC6 fix: activate always scrolls to bottom (new messages are at the end) */
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
        this.container.classList.add('vs-active');
        this.container.replaceChildren(this.spacerTop, this.viewport, this.spacerBottom);
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
        if (toBottom) {
            // Set spacers for bottom position BEFORE render to avoid top flash
            this.spacerTop.style.height = `${this._totalHeight}px`;
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
        const scrollTop = this.container.scrollTop;
        const viewHeight = this.container.clientHeight;

        let accum = 0;
        let startIdx = this.items.length - 1;
        for (let i = 0; i < this.items.length; i++) {
            if (accum + this.items[i].height > scrollTop) {
                startIdx = i;
                break;
            }
            accum += this.items[i].height;
        }

        const first = Math.max(0, startIdx - BUFFER);
        let endAccum = accum;
        let endIdx = startIdx;
        for (let i = startIdx; i < this.items.length; i++) {
            endAccum += this.items[i].height;
            endIdx = i;
            if (endAccum > scrollTop + viewHeight) break;
        }
        const last = Math.min(this.items.length - 1, endIdx + BUFFER);

        // RC3 fix: always update spacers even if range unchanged
        let topSpace = 0;
        for (let i = 0; i < first; i++) topSpace += this.items[i].height;
        let bottomSpace = 0;
        for (let i = last + 1; i < this.items.length; i++) bottomSpace += this.items[i].height;

        this.spacerTop.style.height = `${topSpace}px`;
        this.spacerBottom.style.height = `${bottomSpace}px`;

        if (first === this.firstVisible && last === this.lastVisible) return;
        this.firstVisible = first;
        this.lastVisible = last;

        // Build map of currently mounted items by vsIdx
        const mounted = new Map<number, HTMLElement>();
        for (const child of Array.from(this.viewport.children) as HTMLElement[]) {
            const idx = Number(child.dataset.vsIdx);
            if (!isNaN(idx)) mounted.set(idx, child);
        }

        // Remove items no longer in range
        for (const [idx, el] of mounted) {
            if (idx < first || idx > last) {
                el.remove();
                mounted.delete(idx);
            }
        }

        // Build ordered list — reuse existing or create new
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

        // Reorder viewport children to match (minimal DOM moves)
        let nodeRef = this.viewport.firstChild as HTMLElement | null;
        for (const el of ordered) {
            if (el !== nodeRef) {
                this.viewport.insertBefore(el, nodeRef);
            } else {
                nodeRef = nodeRef.nextSibling as HTMLElement | null;
            }
        }

        // Fire lazy render callback FIRST (replaces skeleton with real content)
        if (this.onLazyRender) {
            const lazyTargets = this.viewport.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        // Fire post-render callback for widget activation
        if (this.onPostRender) {
            this.onPostRender(this.viewport);
        }

        // Batch-read heights AFTER lazy render + widget activation
        this.remeasureVisible();
    }

    /** Batch-read heights from visible elements, batch-write to items array.
     *  Separated read/write passes = single forced reflow. */
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
                heightChanged = true;
            }
        }
        if (heightChanged && wasAtBottom) {
            this.scrollToBottom();
        }
    }

    /** RC2 fix: synchronous scroll — cancel pending RAF, update spacers, render directly */
    scrollToBottom(): void {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        // Update spacers to reflect full content height at bottom position
        this.spacerTop.style.height = `${this._totalHeight}px`;
        this.spacerBottom.style.height = '0px';
        this.container.scrollTop = this.container.scrollHeight;
        // Reset visible range to force full re-render at new position
        this.firstVisible = -1;
        this.lastVisible = -1;
        this.render();
    }

    clear(): void {
        this.items = [];
        this._totalHeight = 0;
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
