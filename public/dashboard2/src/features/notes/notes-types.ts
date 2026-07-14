// 071 — Notes types for dashboard2 (ported from src/manager/types.ts)

export type NoteLinkStatus = 'resolved' | 'missing' | 'ambiguous';
export type NoteLinkReason = 'not_found' | 'invalid_target' | 'ambiguous';

export type NotesViewMode = 'raw' | 'split' | 'preview' | 'settings' | 'graph';
export type NotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';

export type NotesTreeEntry = {
    path: string;
    name: string;
    kind: 'file' | 'folder';
    mtimeMs: number;
    size: number;
    children?: NotesTreeEntry[];
};

export type NoteFile = {
    path: string;
    name: string;
    content: string;
    revision: string;
    mtimeMs: number;
    size: number;
};

export type NoteSearchResult = {
    path: string;
    line: number;
    content: string;
    context: string;
    kind: 'path' | 'content';
};

export type NoteLinkRef = {
    sourcePath: string;
    raw: string;
    target: string;
    displayText?: string;
    heading?: string;
    line: number;
    column: number;
    startOffset: number;
    endOffset: number;
    status: NoteLinkStatus;
    resolvedPath?: string;
    candidatePaths?: string[];
    reason?: NoteLinkReason;
};

export type NoteMetadata = {
    path: string;
    title: string;
    aliases: string[];
    tags: string[];
    created?: string;
    mtimeMs: number;
    size: number;
    revision: string;
    frontmatterError?: string;
};

export type NotesVaultIndexSnapshot = {
    version: number;
    notes: NoteMetadata[];
    outgoingLinks: Record<string, NoteLinkRef[]>;
    backlinks: Record<string, NoteLinkRef[]>;
    unresolvedLinks: NoteLinkRef[];
};

export type NoteConflictState = {
    localContent: string;
    remoteRevision: string;
    message: string;
};
