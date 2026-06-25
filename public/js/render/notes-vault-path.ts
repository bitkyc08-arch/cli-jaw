const RESERVED_NOTE_SEGMENTS = new Set(['.git', '.assets', '_templates', '_snippets', '_plugins']);
const NOTE_FILE_EXT = '.md';

function normalizeSlashes(input: string): string {
    return input.replace(/\\/g, '/').trim();
}

function isReservedNotePath(relPath: string): boolean {
    const top = relPath.split('/')[0] ?? '';
    return RESERVED_NOTE_SEGMENTS.has(top);
}

function looksLikeNoteRelPath(relPath: string): boolean {
    if (!relPath || relPath.startsWith('/') || relPath.includes('..')) return false;
    if (!relPath.endsWith(NOTE_FILE_EXT)) return false;
    if (isReservedNotePath(relPath)) return false;
    return true;
}

function stripVaultRootPrefix(input: string, notesRoot: string): string | null {
    const normalized = normalizeSlashes(input);
    const root = normalizeSlashes(notesRoot).replace(/\/+$/, '');
    if (!root) return null;
    if (normalized === root) return null;
    const prefix = `${root}/`;
    if (!normalized.startsWith(prefix)) return null;
    const rel = normalized.slice(prefix.length);
    return looksLikeNoteRelPath(rel) ? rel : null;
}

function resolveHomeFromNotesRoot(notesRoot: string): string | null {
    const root = normalizeSlashes(notesRoot);
    const mac = root.match(/^(\/Users\/[^/]+)/);
    if (mac) return mac[1];
    const linux = root.match(/^(\/home\/[^/]+)/);
    if (linux) return linux[1];
    return null;
}

function expandTildePath(raw: string, notesRoot: string): string {
    if (!raw.startsWith('~/')) return raw;
    const home = resolveHomeFromNotesRoot(notesRoot);
    if (!home) return raw;
    return `${home}/${raw.slice(2)}`;
}

export function normalizeNotesVaultPath(input: string, notesRoot: string | null): string | null {
    const raw = normalizeSlashes(input);
    if (!raw) return null;

    if (notesRoot && !raw.startsWith('~/') && looksLikeNoteRelPath(raw)) return raw;

    if (!notesRoot) return null;

    const expanded = expandTildePath(raw, notesRoot);
    const absolute = stripVaultRootPrefix(expanded, notesRoot);
    if (absolute) return absolute;

    return null;
}

export function isNotesVaultPath(input: string, notesRoot: string | null): boolean {
    return normalizeNotesVaultPath(input, notesRoot) !== null;
}
