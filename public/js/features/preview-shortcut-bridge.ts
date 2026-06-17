// Forward manager keyboard shortcuts from iframe to parent manager window.
// Only active when the page is embedded as an iframe (preview mode).

const FORWARD_KEYS = new Set(['j', 'k', 'i', 'n', 'p']);

function isForwardedManagerShortcut(e: KeyboardEvent): boolean {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
        let key = e.key.toLowerCase();
        // macOS Option+letter produces special chars (e.g. ∆ for Alt+J).
        if (key.length !== 1 || !FORWARD_KEYS.has(key)) {
            if (e.code?.startsWith('Key')) key = e.code.slice(3).toLowerCase();
        }
        return FORWARD_KEYS.has(key);
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
        return e.code === 'Backquote';
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!e.shiftKey && (e.code === 'Backquote' || e.code === 'KeyB' || e.code === 'KeyJ')) return true;
        if (e.shiftKey && (e.code === 'KeyB' || e.code === 'KeyD' || e.code === 'KeyE')) return true;
    }
    return false;
}

export function initPreviewShortcutBridge(): void {
    if (window.parent === window) return;

    document.addEventListener('keydown', (e) => {
        if (!isForwardedManagerShortcut(e)) return;

        e.preventDefault();
        try {
            window.parent.postMessage({
                type: 'jaw-preview-shortcut',
                key: e.key,
                code: e.code,
                altKey: e.altKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                shiftKey: e.shiftKey,
            }, '*');
        } catch { /* cross-origin guard */ }
    });
}
