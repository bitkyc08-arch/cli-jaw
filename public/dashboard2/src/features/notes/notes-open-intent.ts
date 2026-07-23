type NotesOpenListener = (path: string) => void;

const listeners = new Set<NotesOpenListener>();
const RESERVED_NOTES_SEGMENTS = new Set(['.git', '.assets', '_templates', '_snippets', '_plugins']);

export function subscribeNotesOpen(listener: NotesOpenListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function requestNotesOpen(path: string): void {
    for (const listener of listeners) listener(path);
}

export function normalizeNotesPath(input: string, notesRoot: string): string | null {
    const raw = input.replace(/\\/g, '/').trim();
    const root = notesRoot.replace(/\\/g, '/').trim().replace(/\/+$/, '');
    if (!raw || !root) return null;
    const home = root.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1];
    const expanded = raw.startsWith('~/') && home ? `${home}/${raw.slice(2)}` : raw;
    const windowsAbsolute = /^[A-Za-z]:\//.test(expanded);
    const absolute = expanded.startsWith('/') || windowsAbsolute;
    const comparableInput = windowsAbsolute ? expanded.toLowerCase() : expanded;
    const comparableRoot = windowsAbsolute ? root.toLowerCase() : root;
    const relative = absolute
        ? comparableInput.startsWith(`${comparableRoot}/`) ? expanded.slice(root.length + 1) : null
        : expanded;
    if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '..')) return null;
    if (RESERVED_NOTES_SEGMENTS.has(relative.split('/')[0] ?? '')) return null;
    return relative.endsWith('.md') ? relative : null;
}
