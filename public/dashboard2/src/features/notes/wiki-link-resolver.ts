import type { NoteLinkRef, NoteMetadata } from './notes-types';

export const WIKI_LINK_RE = /\[\[([^\[\]\n]+)\]\]/g;

const WIKI_LINK_TOKEN_RE = /^\[\[([^\[\]\n]+)\]\]$/;
const NOTE_FILE_EXT = '.md';
const RESERVED_NOTE_SEGMENTS = new Set(['.git', '.assets', '_templates', '_snippets', '_plugins']);

export type ParsedWikiLinkToken = {
    raw: string;
    inner: string;
    target: string;
    heading: string | null;
    displayText: string | null;
};

export type ClientWikiLinkResolution = NoteLinkRef & {
    source: 'outgoing' | 'notes-fallback';
};

type NotesIndex = {
    byPath: Map<string, NoteMetadata>;
    byPathNoExt: Map<string, NoteMetadata>;
    byAlias: Map<string, NoteMetadata[]>;
    byStem: Map<string, NoteMetadata[]>;
};

export function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

export function firstUnescaped(text: string, char: string): number {
    for (let index = 0; index < text.length; index++) {
        if (text[index] === char && !isEscaped(text, index)) return index;
    }
    return -1;
}

export function parseWikiLinkToken(raw: string): ParsedWikiLinkToken | null {
    const match = raw.match(WIKI_LINK_TOKEN_RE);
    if (!match) return null;
    const inner = match[1]?.trim() ?? '';
    if (!inner) return null;
    const pipe = firstUnescaped(inner, '|');
    const targetPart = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const displayPart = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
    const headingIndex = firstUnescaped(targetPart, '#');
    const target = (headingIndex === -1 ? targetPart : targetPart.slice(0, headingIndex)).trim();
    const heading = headingIndex === -1 ? '' : targetPart.slice(headingIndex + 1).trim();
    if (!target) return null;
    return {
        raw,
        inner,
        target,
        heading: heading || null,
        displayText: displayPart || null,
    };
}

export function buildOutgoingWikiLinkLookup(
    outgoing: readonly NoteLinkRef[] | undefined | null,
): Map<string, ClientWikiLinkResolution> {
    const map = new Map<string, ClientWikiLinkResolution>();
    if (!outgoing) return map;
    for (const link of outgoing) {
        if (!map.has(link.raw)) map.set(link.raw, { ...link, source: 'outgoing' });
    }
    return map;
}

function appendMulti(map: Map<string, NoteMetadata[]>, key: string, note: NoteMetadata): void {
    const current = map.get(key) ?? [];
    current.push(note);
    map.set(key, current);
}

function pathWithoutExt(path: string): string {
    return path.endsWith(NOTE_FILE_EXT) ? path.slice(0, -NOTE_FILE_EXT.length) : path;
}

function noteStem(path: string): string {
    const filename = path.split('/').at(-1) || path;
    return pathWithoutExt(filename);
}

function buildNotesIndex(notes: readonly NoteMetadata[] | undefined | null): NotesIndex {
    const index: NotesIndex = {
        byPath: new Map(),
        byPathNoExt: new Map(),
        byAlias: new Map(),
        byStem: new Map(),
    };
    for (const note of notes ?? []) {
        index.byPath.set(note.path, note);
        index.byPathNoExt.set(pathWithoutExt(note.path), note);
        for (const alias of note.aliases) appendMulti(index.byAlias, alias, note);
        appendMulti(index.byStem, noteStem(note.path), note);
    }
    return index;
}

function sortedPaths(notes: readonly NoteMetadata[]): string[] {
    return notes.map(note => note.path).sort((a, b) => a.localeCompare(b));
}

function hasReservedNoteSegment(target: string): boolean {
    return target.split('/').some(part => RESERVED_NOTE_SEGMENTS.has(part));
}

export function invalidWikiLinkTarget(target: string): boolean {
    if (!target || target.includes('\0') || target.includes('\\') || target.startsWith('/')) return true;
    const parts = target.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return true;
    return hasReservedNoteSegment(target);
}

function baseLink(
    parsed: ParsedWikiLinkToken,
    startOffset: number,
): ClientWikiLinkResolution {
    return {
        source: 'notes-fallback',
        sourcePath: '',
        raw: parsed.raw,
        target: parsed.target,
        ...(parsed.displayText ? { displayText: parsed.displayText } : {}),
        ...(parsed.heading ? { heading: parsed.heading } : {}),
        line: 0,
        column: 0,
        startOffset,
        endOffset: startOffset + parsed.raw.length,
        status: 'missing',
        reason: 'not_found',
    };
}

function resolved(link: ClientWikiLinkResolution, path: string): ClientWikiLinkResolution {
    const { candidatePaths: _candidatePaths, reason: _reason, ...base } = link;
    return { ...base, status: 'resolved', resolvedPath: path };
}

function missing(
    link: ClientWikiLinkResolution,
    reason: 'not_found' | 'invalid_target',
): ClientWikiLinkResolution {
    const { candidatePaths: _candidatePaths, resolvedPath: _resolvedPath, ...base } = link;
    return { ...base, status: 'missing', reason };
}

function ambiguous(link: ClientWikiLinkResolution, notes: readonly NoteMetadata[]): ClientWikiLinkResolution {
    const { resolvedPath: _resolvedPath, ...base } = link;
    return {
        ...base,
        status: 'ambiguous',
        reason: 'ambiguous',
        candidatePaths: sortedPaths(notes),
    };
}

function matchSingleOrAmbiguous(
    link: ClientWikiLinkResolution,
    notes: readonly NoteMetadata[],
): ClientWikiLinkResolution | null {
    if (notes.length === 0) return null;
    const [first] = notes;
    if (notes.length === 1 && first) return resolved(link, first.path);
    return ambiguous(link, notes);
}

export function resolveClientWikiLink(
    raw: string,
    outgoing: readonly NoteLinkRef[] | undefined | null,
    notes: readonly NoteMetadata[] | undefined | null,
    startOffset = 0,
): ClientWikiLinkResolution | null {
    const outgoingLink = buildOutgoingWikiLinkLookup(outgoing).get(raw);
    if (outgoingLink) return outgoingLink;

    const parsed = parseWikiLinkToken(raw);
    if (!parsed) return null;
    const link = baseLink(parsed, startOffset);
    const target = parsed.target.trim();
    if (invalidWikiLinkTarget(target)) return missing(link, 'invalid_target');

    const index = buildNotesIndex(notes);
    const exact = index.byPath.get(target);
    if (exact) return resolved(link, exact.path);

    if (!target.endsWith(NOTE_FILE_EXT)) {
        const withExt = index.byPath.get(`${target}${NOTE_FILE_EXT}`);
        if (withExt) return resolved(link, withExt.path);
        const noExt = index.byPathNoExt.get(target);
        if (noExt) return resolved(link, noExt.path);
    }

    const alias = matchSingleOrAmbiguous(link, index.byAlias.get(target) ?? []);
    if (alias) return alias;

    if (!target.includes('/')) {
        const stem = matchSingleOrAmbiguous(link, index.byStem.get(target) ?? []);
        if (stem) return stem;
    }

    return link;
}

export function wikiLinkDisplayText(link: Pick<NoteLinkRef, 'target' | 'displayText'>, raw: string): string {
    const parsed = parseWikiLinkToken(raw);
    return link.displayText || parsed?.displayText || parsed?.inner || link.target || raw;
}

export function wikiLinkReasonLabel(link: Pick<NoteLinkRef, 'reason'>): string {
    if (link.reason === 'ambiguous') return 'Ambiguous link target';
    if (link.reason === 'invalid_target') return 'Invalid link target';
    return 'No matching note';
}
