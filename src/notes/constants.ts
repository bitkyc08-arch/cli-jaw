export const NOTES_RESERVED_DIRS = new Set<string>([
    '.git',
    '.assets',
    '_templates',
    '_snippets',
    '_plugins',
]);

export function hasReservedNoteSegment(relPath: string): boolean {
    return relPath.split('/').some(part => NOTES_RESERVED_DIRS.has(part));
}
