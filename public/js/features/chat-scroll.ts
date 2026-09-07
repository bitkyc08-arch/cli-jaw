import { getVirtualScroll, type RestoreReason } from '../virtual-scroll.js';

let scrollRAF: number | null = null;
let userNearBottom = true;
type ScrollIntent = 'unknown' | 'following' | 'pinnedAway';
let scrollIntent: ScrollIntent = 'unknown';
let scrollTrackingBound = false;
const SCROLL_BOTTOM_THRESHOLD = 80; // px
const RESTORE_INDICATOR_SETTLE_MS = 1100;
let chatRestoreIndicatorHideTimer: number | null = null;
const chatRestorePassTimers = new Set<number>();
const chatRestorePassRafs = new Set<number>();

export function canFollowAfterRestore(): boolean {
    return scrollIntent !== 'pinnedAway';
}

export function markFollowingBottom(): void {
    userNearBottom = true;
    scrollIntent = 'following';
    updateScrollFabVisibility();
}

function updateScrollIntentFromDistance(dist: number): void {
    userNearBottom = dist < SCROLL_BOTTOM_THRESHOLD;
    scrollIntent = userNearBottom ? 'following' : 'pinnedAway';
    if (scrollIntent === 'pinnedAway') cancelPendingChatRestorePasses();
    updateScrollFabVisibility();
}

function cancelPendingChatRestorePasses(): void {
    for (const timer of chatRestorePassTimers) window.clearTimeout(timer);
    chatRestorePassTimers.clear();
    for (const raf of chatRestorePassRafs) cancelAnimationFrame(raf);
    chatRestorePassRafs.clear();
}

function requestChatRestoreFrame(callback: () => void): void {
    const raf = requestAnimationFrame(() => {
        chatRestorePassRafs.delete(raf);
        callback();
    });
    chatRestorePassRafs.add(raf);
}

function trackChatRestoreTimer(timer: number): void {
    chatRestorePassTimers.add(timer);
}

function scheduleChatRestoreTimer(callback: () => void, delayMs: number): void {
    const timer = window.setTimeout(() => {
        chatRestorePassTimers.delete(timer);
        callback();
    }, delayMs);
    trackChatRestoreTimer(timer);
}

export function ensureScrollTracking(): void {
    getVirtualScroll().setRestoreFollowPredicate(canFollowAfterRestore);
    window.__jawProcessBlockLayoutMutation = (anchor, mutate) => {
        const vs = getVirtualScroll();
        if (vs.active) {
            vs.preserveScrollDuringMutation(anchor, mutate);
            return;
        }
        mutate();
    };
    if (scrollTrackingBound) return;
    const c = document.getElementById('chatMessages');
    if (!c) return;
    scrollTrackingBound = true;
    c.addEventListener('scroll', () => {
        const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
        updateScrollIntentFromDistance(dist);
    }, { passive: true });
    initScrollFab();
}

export function isChatNearBottom(): boolean {
    ensureScrollTracking();
    const c = document.getElementById('chatMessages');
    if (!c) return userNearBottom;
    const vs = getVirtualScroll();
    if (vs.active) return vs.isNearBottom(SCROLL_BOTTOM_THRESHOLD);
    const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
    return dist < SCROLL_BOTTOM_THRESHOLD;
}

export function reconcileChatBottomAfterLayout(shouldFollow = isChatNearBottom()): void {
    ensureScrollTracking();
    if (!shouldFollow) return;
    markFollowingBottom();
    const vs = getVirtualScroll();
    if (vs.active) {
        vs.reconcileBottomAfterLayout('reconnect', true);
        return;
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const c = document.getElementById('chatMessages');
            if (c) c.scrollTop = c.scrollHeight;
        });
    });
}

export function showChatRestoreIndicator(reason: string): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
        chatRestoreIndicatorHideTimer = null;
    }
    const host = document.querySelector('.chat-area') as HTMLElement | null;
    if (!host) return;
    let indicator = host.querySelector('[data-restore-indicator="true"]') as HTMLElement | null;
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'chat-restore-indicator';
        indicator.setAttribute('data-restore-indicator', 'true');
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        indicator.innerHTML = '<span class="chat-restore-dot"></span><span class="chat-restore-text">Restoring</span>';
        host.appendChild(indicator);
    }
    indicator.dataset['restoreReason'] = reason;
}

export function hideChatRestoreIndicator(): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
        chatRestoreIndicatorHideTimer = null;
    }
    document.querySelectorAll('[data-restore-indicator="true"]').forEach(el => el.remove());
}

export function hideChatRestoreIndicatorAfterSettle(delayMs = RESTORE_INDICATOR_SETTLE_MS): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
    }
    chatRestoreIndicatorHideTimer = window.setTimeout(() => {
        chatRestoreIndicatorHideTimer = null;
        hideChatRestoreIndicator();
    }, delayMs);
}

export function reconcileChatBottomAfterRestore(reason: string): void {
    showChatRestoreIndicator(reason);
    hideChatRestoreIndicatorAfterSettle();
    ensureScrollTracking();
    const vs = getVirtualScroll();
    if (vs.active) {
        vs.reconcileAfterRestore(reason as RestoreReason, canFollowAfterRestore);
        return;
    }
    if (!canFollowAfterRestore()) return;
    const scrollIfFollowing = () => {
        if (!canFollowAfterRestore()) {
            cancelPendingChatRestorePasses();
            return;
        }
        const c = document.getElementById('chatMessages');
        if (c) {
            c.scrollTop = c.scrollHeight;
            markFollowingBottom();
        }
    };
    const runRestorePass = () => {
        if (!canFollowAfterRestore()) {
            cancelPendingChatRestorePasses();
            return;
        }
        requestChatRestoreFrame(scrollIfFollowing);
    };
    runRestorePass();
    requestChatRestoreFrame(runRestorePass);
    requestChatRestoreFrame(() => requestChatRestoreFrame(runRestorePass));
    scheduleChatRestoreTimer(runRestorePass, 250);
    scheduleChatRestoreTimer(runRestorePass, 1000);
    void document.fonts?.ready.then(runRestorePass);
}

export function settleChatBottomAfterInitialLoad(): void {
    ensureScrollTracking();
    markFollowingBottom();
    const vs = getVirtualScroll();
    if (vs.active) {
        vs.reconcileAfterRestore('manual', canFollowAfterRestore);
        return;
    }
    const scrollIfFollowing = () => {
        if (!canFollowAfterRestore()) {
            cancelPendingChatRestorePasses();
            return;
        }
        const c = document.getElementById('chatMessages');
        if (c) {
            c.scrollTop = c.scrollHeight;
            markFollowingBottom();
        }
    };
    const runSettlePass = () => {
        if (!canFollowAfterRestore()) {
            cancelPendingChatRestorePasses();
            return;
        }
        requestChatRestoreFrame(scrollIfFollowing);
    };
    runSettlePass();
    requestChatRestoreFrame(runSettlePass);
    requestChatRestoreFrame(() => requestChatRestoreFrame(runSettlePass));
    scheduleChatRestoreTimer(runSettlePass, 250);
    scheduleChatRestoreTimer(runSettlePass, 1000);
    void document.fonts?.ready.then(runSettlePass);
}

export function scrollToBottom(force = false): void {
    ensureScrollTracking();
    if (!force && !userNearBottom) return;
    if (force) markFollowingBottom();
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        // Re-read VS state inside the frame: activation can flip between
        // schedule and fire (threshold promotion). One rAF gate batches BOTH
        // paths — streaming emits scrollToBottom per chunk/tool event, and the
        // VS branch used to run virtualizer.scrollToIndex + scrollTop reads
        // synchronously per call.
        const vs = getVirtualScroll();
        if (vs.active) {
            vs.scrollToBottom();
            return;
        }
        const c = document.getElementById('chatMessages');
        if (c) c.scrollTop = c.scrollHeight;
    });
}

// ── Scroll-to-Bottom FAB ──
let fabEl: HTMLButtonElement | null = null;
let fabVisible = false;

function createScrollFab(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'scroll-to-bottom-fab';
    btn.setAttribute('aria-label', 'Scroll to bottom');
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.addEventListener('click', () => scrollToBottom(true));
    return btn;
}

function initScrollFab(): void {
    const host = document.querySelector('.chat-area') as HTMLElement | null;
    if (!host || fabEl) return;
    fabEl = createScrollFab();
    host.appendChild(fabEl);
}

function updateScrollFabVisibility(): void {
    if (!fabEl) return;
    const shouldShow = scrollIntent === 'pinnedAway';
    if (shouldShow === fabVisible) return;
    fabVisible = shouldShow;
    fabEl.classList.toggle('visible', shouldShow);
}
