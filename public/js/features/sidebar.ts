// ── Sidebar Collapse ──
// Toggle left/right sidebars. Responsive-aware:
// - Wide viewport (>900px): persist *-collapsed classes
// - Narrow viewport (≤900px): CSS auto-collapses, expanded panels are transient

import { ICONS } from '../icons.js';

interface SidebarState {
    left?: boolean;
    right?: boolean;
}

const STORAGE_KEY = 'sidebarState';
const BREAKPOINT = 900;
const OVERLAY_BREAKPOINT = 768;

function isOverlayMode(): boolean {
    return window.innerWidth <= OVERLAY_BREAKPOINT;
}

function clearExpandedPanels(): void {
    document.body.classList.remove('left-expanded', 'right-expanded');
}

function toggleExpandedPanel(side: 'left' | 'right'): void {
    const ownClass = `${side}-expanded`;
    const otherClass = side === 'left' ? 'right-expanded' : 'left-expanded';
    const willOpen = !document.body.classList.contains(ownClass);
    document.body.classList.remove(otherClass);
    document.body.classList.toggle(ownClass, willOpen);
}

export function initSidebar(): void {
    let saved: SidebarState = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* corrupted */ }
    if (saved.left) document.body.classList.add('left-collapsed');
    if (saved.right) document.body.classList.add('right-collapsed');
    let wasOverlayMode = isOverlayMode();

    document.getElementById('toggleLeft')?.addEventListener('click', toggleLeft);
    document.getElementById('toggleRight')?.addEventListener('click', toggleRight);

    // On resize: sync classes with viewport mode
    window.addEventListener('resize', () => {
        const overlayMode = isOverlayMode();

        if (window.innerWidth > BREAKPOINT) {
            clearExpandedPanels();
            let s: SidebarState = {};
            try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* corrupted */ }
            document.body.classList.toggle('left-collapsed', !!s.left);
            document.body.classList.toggle('right-collapsed', !!s.right);
        } else {
            document.body.classList.remove('left-collapsed', 'right-collapsed');
            if (overlayMode !== wasOverlayMode) {
                clearExpandedPanels();
            }
        }

        wasOverlayMode = overlayMode;
        syncIcons();
    });

    if (window.innerWidth <= BREAKPOINT) {
        document.body.classList.remove('left-collapsed', 'right-collapsed');
        if (isOverlayMode()) {
            clearExpandedPanels();
        }
    }
    syncIcons();
}

function isNarrow(): boolean {
    return window.innerWidth <= BREAKPOINT;
}

export function toggleLeft(): void {
    if (isNarrow()) {
        toggleExpandedPanel('left');
    } else {
        document.body.classList.toggle('left-collapsed');
    }
    save();
    syncIcons();
}

export function toggleRight(): void {
    if (isNarrow()) {
        toggleExpandedPanel('right');
    } else {
        document.body.classList.toggle('right-collapsed');
    }
    save();
    syncIcons();
}

function isLeftOpen(): boolean {
    if (isNarrow()) return document.body.classList.contains('left-expanded');
    return !document.body.classList.contains('left-collapsed');
}

function isRightOpen(): boolean {
    if (isNarrow()) return document.body.classList.contains('right-expanded');
    return !document.body.classList.contains('right-collapsed');
}

function syncIcons(): void {
    const leftBtn = document.getElementById('toggleLeft');
    const rightBtn = document.getElementById('toggleRight');
    if (leftBtn) leftBtn.innerHTML = isLeftOpen() ? ICONS.chevronLeft : ICONS.chevronRight;
    if (rightBtn) rightBtn.innerHTML = isRightOpen() ? ICONS.chevronRight : ICONS.chevronLeft;
}

function save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: document.body.classList.contains('left-collapsed'),
        right: document.body.classList.contains('right-collapsed'),
    }));
}
