import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { posix } from 'node:path';

export const NOTE_FILE_EXT = '.md';
export const MAX_NOTE_BYTES = 1_048_576;

export type NotePathError = Error & {
    statusCode: number;
    code: string;
};

export function notePathError(statusCode: number, code: string, message = code): NotePathError {
    const error = new Error(message) as NotePathError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function assertStringPath(input: unknown): string {
    if (typeof input !== 'string') {
        throw notePathError(400, 'invalid_note_path', 'note path must be a string');
    }
    const trimmed = input.trim();
    if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) {
        throw notePathError(400, 'invalid_note_path', 'note path is invalid');
    }
    if (isAbsolute(trimmed) || trimmed.startsWith('/')) {
        throw notePathError(400, 'invalid_note_path', 'note path must be relative');
    }
    const normalized = posix.normalize(trimmed);
    if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
        throw notePathError(400, 'invalid_note_path', 'note path cannot escape notes root');
    }
    if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw notePathError(400, 'invalid_note_path', 'note path contains invalid segments');
    }
    return normalized;
}

export function assertNoteRelPath(input: unknown): string {
    const normalized = assertStringPath(input);
    if (!normalized.endsWith(NOTE_FILE_EXT)) {
        throw notePathError(400, 'invalid_note_path', 'note files must use .md');
    }
    return normalized;
}

export function assertNoteFolderRelPath(input: unknown): string {
    const normalized = assertStringPath(input);
    if (normalized.endsWith(NOTE_FILE_EXT)) {
        throw notePathError(400, 'invalid_note_folder_path', 'folder paths must not use .md');
    }
    return normalized;
}

export function isPathInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function assertRealPathInside(root: string, target: string): Promise<void> {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!isPathInside(realRoot, realTarget)) {
        throw notePathError(400, 'note_path_escape', 'note path escapes notes root');
    }
}

export async function assertNotSymlink(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
        throw notePathError(400, 'note_symlink_rejected', 'symlinks are not supported in notes');
    }
}

export function resolveNotePath(root: string, relPath: string): string {
    return join(root, ...relPath.split('/'));
}

export function parentRelPath(relPath: string): string | null {
    const parent = posix.dirname(relPath);
    return parent === '.' ? null : parent;
}

export function encodeTrashPath(relPath: string): string {
    return relPath.split('/').join('__').replaceAll(sep, '__');
}
