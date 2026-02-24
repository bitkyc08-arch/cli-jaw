// ── Sidebar Collapse ──
// Toggle left/right sidebars. Responsive-aware:
// - Wide viewport (>900px): toggle *-collapsed classes
// - Narrow viewport (≤900px): CSS auto-collapses, toggle *-expanded to override

const STORAGE_KEY = 'sidebarState';
const BREAKPOINT = 900;

export function initSidebar() {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.left) document.body.classList.add('left-collapsed');
    if (saved.right) document.body.classList.add('right-collapsed');

    document.getElementById('toggleLeft')?.addEventListener('click', toggleLeft);
    document.getElementById('toggleRight')?.addEventListener('click', toggleRight);

    // On resize: sync classes with viewport mode
    window.addEventListener('resize', () => {
        if (window.innerWidth > BREAKPOINT) {
            // Wide: remove expanded, restore collapsed from storage
            document.body.classList.remove('left-expanded', 'right-expanded');
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            document.body.classList.toggle('left-collapsed', !!s.left);
            document.body.classList.toggle('right-collapsed', !!s.right);
        } else {
            // Narrow: suspend collapsed (CSS media query handles auto-collapse)
            document.body.classList.remove('left-collapsed', 'right-collapsed');
        }
        syncIcons();
    });

    // If starting narrow, suspend collapsed
    if (window.innerWidth <= BREAKPOINT) {
        document.body.classList.remove('left-collapsed', 'right-collapsed');
    }

    syncIcons();
}

function isNarrow() {
    return window.innerWidth <= BREAKPOINT;
}

export function toggleLeft() {
    if (isNarrow()) {
        // Narrow mode: toggle expanded override
        document.body.classList.toggle('left-expanded');
    } else {
        // Wide mode: toggle collapsed
        document.body.classList.toggle('left-collapsed');
    }
    save();
    syncIcons();
}

export function toggleRight() {
    if (isNarrow()) {
        document.body.classList.toggle('right-expanded');
    } else {
        document.body.classList.toggle('right-collapsed');
    }
    save();
    syncIcons();
}

function isLeftOpen() {
    if (isNarrow()) return document.body.classList.contains('left-expanded');
    return !document.body.classList.contains('left-collapsed');
}

function isRightOpen() {
    if (isNarrow()) return document.body.classList.contains('right-expanded');
    return !document.body.classList.contains('right-collapsed');
}

function syncIcons() {
    const leftBtn = document.getElementById('toggleLeft');
    const rightBtn = document.getElementById('toggleRight');
    if (leftBtn) leftBtn.textContent = isLeftOpen() ? '◀' : '▶';
    if (rightBtn) rightBtn.textContent = isRightOpen() ? '▶' : '◀';
}

function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: document.body.classList.contains('left-collapsed'),
        right: document.body.classList.contains('right-collapsed'),
    }));
}
