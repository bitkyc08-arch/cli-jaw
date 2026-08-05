import { createHash } from 'node:crypto';
import {
    lstat,
    readFile,
    readdir,
    realpath,
    stat,
} from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { posix } from 'node:path';
import {
    MAX_NOTE_BYTES,
    NOTE_FILE_EXT,
    isPathInside,
    resolveNotePath,
} from '../../notes/path-guards.js';
import { hasReservedNoteSegment } from '../../notes/constants.js';
import { parseLeadingFrontmatter, normalizeFrontmatter } from './frontmatter.js';
import { extractWikiLinks } from './wiki-links.js';
import { resolveWikiLinks } from './link-resolver.js';
import type {
    NoteGraphEdge,
    NoteGraphNode,
    NoteIndexWarning,
    NoteLinkRef,
    NoteMetadata,
    VaultIndexSnapshot,
} from '../types.js';

export type NotesIndexFs = {
    lstat: typeof lstat;
    readFile: typeof readFile;
    readdir: typeof readdir;
    realpath: typeof realpath;
    stat: typeof stat;
};

export type NotesVaultIndexOptions = {
    root: string;
    watcherVersion?: () => number;
    fsImpl?: NotesIndexFs;
};

const DEFAULT_FS: NotesIndexFs = {
    lstat,
    readFile,
    readdir,
    realpath,
    stat,
};

type PendingNote = {
    metadata: NoteMetadata;
    links: NoteLinkRef[];
};

function revisionFor(content: string, fileStat: Stats): string {
    return createHash('sha256')
        .update(content)
        .update(String(fileStat.mtimeMs))
        .update(String(fileStat.size))
        .digest('hex');
}

function titleFromPath(path: string): string {
    const name = posix.basename(path, NOTE_FILE_EXT);
    return name || path;
}

function sortByPath<T extends { path: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.path.localeCompare(b.path));
}

function sortLinks(links: NoteLinkRef[]): NoteLinkRef[] {
    return [...links].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)
        || a.startOffset - b.startOffset
        || a.raw.localeCompare(b.raw));
}

function sortedRecord<T>(
    entries: Iterable<[string, T[]]>,
    sortItems: (items: T[]) => T[],
): Record<string, T[]> {
    const record: Record<string, T[]> = {};
    for (const [key, value] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
        record[key] = sortItems(value);
    }
    return record;
}

function virtualNodeId(link: NoteLinkRef): string {
    const target = link.target || '<empty>';
    return `${link.status}:${target}`;
}

function buildGraph(notes: NoteMetadata[], links: NoteLinkRef[]): VaultIndexSnapshot['graph'] {
    const nodes = new Map<string, NoteGraphNode>();
    for (const note of notes) {
        nodes.set(note.path, {
            id: note.path,
            title: note.title,
            kind: 'note',
            path: note.path,
        });
    }

    const edges: NoteGraphEdge[] = [];
    for (const link of links) {
        const target = link.resolvedPath || virtualNodeId(link);
        if (!link.resolvedPath && !nodes.has(target)) {
            nodes.set(target, {
                id: target,
                title: link.target || '(empty link)',
                kind: link.status === 'ambiguous' ? 'ambiguous' : 'missing',
                ...(link.candidatePaths ? { candidatePaths: link.candidatePaths } : {}),
            });
        }
        edges.push({
            source: link.sourcePath,
            target,
            raw: link.raw,
            status: link.status,
            ...(link.resolvedPath ? { resolvedPath: link.resolvedPath } : {}),
        });
    }

    return {
        nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
        edges: edges.sort((a, b) => a.source.localeCompare(b.source)
            || a.target.localeCompare(b.target)
            || a.raw.localeCompare(b.raw)),
    };
}

function fingerprintSnapshot(snapshot: Omit<VaultIndexSnapshot, 'version'>, watcherVersion: number): string {
    return JSON.stringify({
        watcherVersion,
        notes: snapshot.notes,
        outgoingLinks: snapshot.outgoingLinks,
        errors: snapshot.errors,
    });
}

export class NotesVaultIndex {
    private readonly root: string;
    private readonly fs: NotesIndexFs;
    private readonly watcherVersion: () => number;
    private lastFingerprint = '';
    private version = 0;

    constructor(options: NotesVaultIndexOptions) {
        this.root = options.root;
        this.fs = options.fsImpl || DEFAULT_FS;
        this.watcherVersion = options.watcherVersion || (() => 0);
    }

    async snapshot(): Promise<VaultIndexSnapshot> {
        const pending = await this.collectNotes();
        const notes = sortByPath(pending.map(note => note.metadata));
        const sourceLinks = pending.flatMap(note => note.links);
        const resolvedLinks = sortLinks(resolveWikiLinks(sourceLinks, notes));
        const outgoing = new Map<string, NoteLinkRef[]>();
        const backlinks = new Map<string, NoteLinkRef[]>();
        const unresolved: NoteLinkRef[] = [];

        for (const note of notes) outgoing.set(note.path, []);
        for (const link of resolvedLinks) {
            outgoing.set(link.sourcePath, [...(outgoing.get(link.sourcePath) || []), link]);
            if (link.status === 'resolved' && link.resolvedPath) {
                backlinks.set(link.resolvedPath, [...(backlinks.get(link.resolvedPath) || []), link]);
            } else {
                unresolved.push(link);
            }
        }

        const body: Omit<VaultIndexSnapshot, 'version'> = {
            notes,
            outgoingLinks: sortedRecord(outgoing, sortLinks),
            backlinks: sortedRecord(backlinks, sortLinks),
            unresolvedLinks: sortLinks(unresolved),
            graph: buildGraph(notes, resolvedLinks),
            errors: sortByPath(this.errors),
        };
        const fingerprint = fingerprintSnapshot(body, this.watcherVersion());
        if (fingerprint !== this.lastFingerprint) {
            this.version++;
            this.lastFingerprint = fingerprint;
        }
        return { version: this.version, ...body };
    }

    private errors: NoteIndexWarning[] = [];

    private async collectNotes(): Promise<PendingNote[]> {
        this.errors = [];
        try {
            const realRoot = await this.fs.realpath(this.root);
            return await this.collectFolder('', realRoot);
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    private async collectFolder(relFolder: string, realRoot: string): Promise<PendingNote[]> {
        const folder = relFolder ? resolveNotePath(this.root, relFolder) : this.root;
        const entries = await this.fs.readdir(folder, { withFileTypes: true });
        const notes: PendingNote[] = [];
        for (const entry of entries) {
            const relPath = relFolder ? `${relFolder}/${entry.name}` : entry.name;
            if (hasReservedNoteSegment(relPath)) continue;
            const entryNotes = await this.collectEntry(entry, relPath, realRoot);
            notes.push(...entryNotes);
        }
        return notes;
    }

    private async collectEntry(entry: Dirent, relPath: string, realRoot: string): Promise<PendingNote[]> {
        const target = resolveNotePath(this.root, relPath);
        const entryStat = await this.fs.lstat(target);
        if (entryStat.isSymbolicLink()) {
            this.errors.push({
                code: 'note_symlink_skipped',
                path: relPath,
                message: 'symlinks are not indexed in notes',
            });
            return [];
        }
        const realTarget = await this.fs.realpath(target);
        if (!isPathInside(realRoot, realTarget)) {
            this.errors.push({
                code: 'note_symlink_skipped',
                path: relPath,
                message: 'note path resolves outside notes root',
            });
            return [];
        }
        if (entry.isDirectory()) return await this.collectFolder(relPath, realRoot);
        if (!entry.isFile() || !entry.name.endsWith(NOTE_FILE_EXT)) return [];

        const fileStat = await this.fs.stat(target);
        if (fileStat.size > MAX_NOTE_BYTES) {
            this.errors.push({
                code: 'note_file_too_large',
                path: relPath,
                message: 'note file exceeds the maximum supported size',
            });
            return [];
        }
        const content = await this.fs.readFile(target, 'utf8');
        const parsed = parseLeadingFrontmatter(content);
        const frontmatter = normalizeFrontmatter(relPath, parsed.data);
        if (parsed.error) {
            this.errors.push({
                code: 'frontmatter_parse_error',
                path: relPath,
                message: parsed.error,
            });
        }
        this.errors.push(...frontmatter.warnings);
        const metadata: NoteMetadata = {
            path: relPath,
            title: frontmatter.title || titleFromPath(relPath),
            aliases: frontmatter.aliases,
            tags: frontmatter.tags,
            ...(frontmatter.created ? { created: frontmatter.created } : {}),
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            revision: revisionFor(content, fileStat),
            ...(parsed.error ? { frontmatterError: parsed.error } : {}),
        };
        return [{ metadata, links: extractWikiLinks(relPath, content) }];
    }
}
