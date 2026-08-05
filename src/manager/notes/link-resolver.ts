import { posix } from 'node:path';
import { NOTE_FILE_EXT } from '../../notes/path-guards.js';
import { hasReservedNoteSegment } from '../../notes/constants.js';
import type { NoteLinkRef, NoteMetadata } from '../types.js';

type ResolverIndex = {
    byPath: Map<string, NoteMetadata>;
    byPathNoExt: Map<string, NoteMetadata>;
    byAlias: Map<string, NoteMetadata[]>;
    byStem: Map<string, NoteMetadata[]>;
};

function sortedPaths(notes: NoteMetadata[]): string[] {
    return notes.map(note => note.path).sort((a, b) => a.localeCompare(b));
}

function appendMulti(map: Map<string, NoteMetadata[]>, key: string, note: NoteMetadata): void {
    const current = map.get(key) || [];
    current.push(note);
    map.set(key, current);
}

export function buildResolverIndex(notes: NoteMetadata[]): ResolverIndex {
    const index: ResolverIndex = {
        byPath: new Map(),
        byPathNoExt: new Map(),
        byAlias: new Map(),
        byStem: new Map(),
    };
    for (const note of notes) {
        index.byPath.set(note.path, note);
        if (note.path.endsWith(NOTE_FILE_EXT)) {
            index.byPathNoExt.set(note.path.slice(0, -NOTE_FILE_EXT.length), note);
        }
        for (const alias of note.aliases) {
            appendMulti(index.byAlias, alias, note);
        }
        const basename = posix.basename(note.path, NOTE_FILE_EXT);
        appendMulti(index.byStem, basename, note);
    }
    return index;
}

function invalidTarget(target: string): boolean {
    if (!target || target.includes('\0') || target.includes('\\') || target.startsWith('/')) return true;
    const normalized = posix.normalize(target);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return true;
    if (normalized.split('/').some(part => !part || part === '.' || part === '..')) return true;
    return hasReservedNoteSegment(normalized);
}

function resolved(ref: NoteLinkRef, path: string): NoteLinkRef {
    const { candidatePaths: _candidatePaths, reason: _reason, ...base } = ref;
    return { ...base, status: 'resolved', resolvedPath: path };
}

function missing(ref: NoteLinkRef, reason: 'not_found' | 'invalid_target'): NoteLinkRef {
    const { candidatePaths: _candidatePaths, resolvedPath: _resolvedPath, ...base } = ref;
    return { ...base, status: 'missing', reason };
}

function ambiguous(ref: NoteLinkRef, notes: NoteMetadata[]): NoteLinkRef {
    const { resolvedPath: _resolvedPath, ...base } = ref;
    return {
        ...base,
        status: 'ambiguous',
        reason: 'ambiguous',
        candidatePaths: sortedPaths(notes),
    };
}

function matchSingleOrAmbiguous(ref: NoteLinkRef, candidates: NoteMetadata[]): NoteLinkRef | null {
    if (candidates.length === 0) return null;
    const [first] = candidates;
    if (candidates.length === 1 && first) return resolved(ref, first.path);
    return ambiguous(ref, candidates);
}

export function resolveWikiLink(ref: NoteLinkRef, index: ResolverIndex): NoteLinkRef {
    const target = ref.target.trim();
    if (invalidTarget(target)) return missing(ref, 'invalid_target');

    const exact = index.byPath.get(target);
    if (exact) return resolved(ref, exact.path);

    if (!target.endsWith(NOTE_FILE_EXT)) {
        const withExt = index.byPath.get(`${target}${NOTE_FILE_EXT}`);
        if (withExt) return resolved(ref, withExt.path);
        const noExt = index.byPathNoExt.get(target);
        if (noExt) return resolved(ref, noExt.path);
    }

    const alias = matchSingleOrAmbiguous(ref, index.byAlias.get(target) || []);
    if (alias) return alias;

    if (!target.includes('/')) {
        const stem = matchSingleOrAmbiguous(ref, index.byStem.get(target) || []);
        if (stem) return stem;
    }

    return missing(ref, 'not_found');
}

export function resolveWikiLinks(refs: NoteLinkRef[], notes: NoteMetadata[]): NoteLinkRef[] {
    const index = buildResolverIndex(notes);
    return refs.map(ref => resolveWikiLink(ref, index));
}
