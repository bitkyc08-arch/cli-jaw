// ── Sidebar Collapse ──
// Toggle left/right sidebars. Responsive-aware:
// - Wide viewport (>900px): toggle *-collapsed classes
// - Narrow viewport (≤900px): CSS auto-collapses, toggle *-expanded to override

interface SidebarState {
    left?: boolean;
    right?: boolean;
}

const STORAGE_KEY = 'sidebarState';
const BREAKPOINT = 900;

export function initSidebar(): void {
    const saved: SidebarState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.left) document.body.classList.add('left-collapsed');
    if (saved.right) document.body.classList.add('right-collapsed');

    document.getElementById('toggleLeft')?.addEventListener('click', toggleLeft);
    document.getElementById('toggleRight')?.addEventListener('click', toggleRight);

    // On resize: sync classes with viewport mode
    window.addEventListener('resize', () => {
        if (window.innerWidth > BREAKPOINT) {
            document.body.classList.remove('left-expanded', 'right-expanded');
            const s: SidebarState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            document.body.classList.toggle('left-collapsed', !!s.left);
            document.body.classList.toggle('right-collapsed', !!s.right);
        } else {
            document.body.classList.remove('left-collapsed', 'right-collapsed');
        }
        syncIcons();
    });

    if (window.innerWidth <= BREAKPOINT) {
        document.body.classList.remove('left-collapsed', 'right-collapsed');
    }
    syncIcons();
}

function isNarrow(): boolean {
    return window.innerWidth <= BREAKPOINT;
}

export function toggleLeft(): void {
    if (isNarrow()) {
        document.body.classList.toggle('left-expanded');
    } else {
        document.body.classList.toggle('left-collapsed');
    }
    save();
    syncIcons();
}

export function toggleRight(): void {
    if (isNarrow()) {
        document.body.classList.toggle('right-expanded');
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
    if (leftBtn) leftBtn.textContent = isLeftOpen() ? '◀' : '▶';
    if (rightBtn) rightBtn.textContent = isRightOpen() ? '▶' : '◀';
}

function save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: document.body.classList.contains('left-collapsed'),
        right: document.body.classList.contains('right-collapsed'),
    }));
}
