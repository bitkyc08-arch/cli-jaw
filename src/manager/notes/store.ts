import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    stat,
    writeFile,
} from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { dashboardPath } from '../dashboard-home.js';
import type {
    DashboardNoteFileResponse,
    DashboardNoteTreeEntry,
    DashboardPutNoteRequest,
} from '../types.js';
import {
    MAX_NOTE_BYTES,
    NOTE_FILE_EXT,
    assertNoteFolderRelPath,
    assertNoteRelPath,
    assertNotSymlink,
    assertRealPathInside,
    notePathError,
    parentRelPath,
    resolveNotePath,
} from './path-guards.js';

export type NotesStoreFs = {
    existsSync: typeof existsSync;
    lstat: typeof lstat;
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    readdir: typeof readdir;
    realpath: typeof realpath;
    rename: typeof rename;
    stat: typeof stat;
    writeFile: typeof writeFile;
};

export type NotesStoreOptions = {
    root?: string;
    fsImpl?: NotesStoreFs;
};

const DEFAULT_FS: NotesStoreFs = {
    existsSync,
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    stat,
    writeFile,
};

export class NotesStore {
    private readonly root: string;
    private readonly fs: NotesStoreFs;

    constructor(options: NotesStoreOptions = {}) {
        this.root = options.root || dashboardPath('notes');
        this.fs = options.fsImpl || DEFAULT_FS;
    }

    rootPath(): string {
        return this.root;
    }

    async listTree(): Promise<DashboardNoteTreeEntry[]> {
        await this.ensureRoot();
        return await this.listFolder('');
    }

    async readFile(path: string): Promise<DashboardNoteFileResponse> {
        const relPath = assertNoteRelPath(path);
        const target = await this.existingFilePath(relPath);
        const fileStat = await this.fs.stat(target);
        if (fileStat.size > MAX_NOTE_BYTES) {
            throw notePathError(413, 'note_file_too_large', 'note file exceeds the maximum supported size');
        }
        const content = await this.fs.readFile(target, 'utf8');
        return this.fileResponse(relPath, content, fileStat.mtimeMs, fileStat.size);
    }

    async createFile(path: string, content = ''): Promise<DashboardNoteFileResponse> {
        const relPath = assertNoteRelPath(path);
        await this.assertWritableTarget(relPath);
        if (this.fs.existsSync(resolveNotePath(this.root, relPath))) {
            throw notePathError(409, 'note_path_exists', 'note file already exists');
        }
        await this.assertContentSize(content);
        const target = resolveNotePath(this.root, relPath);
        await this.fs.writeFile(target, content, { flag: 'wx' });
        return await this.readFile(relPath);
    }

    async writeFile(request: DashboardPutNoteRequest): Promise<DashboardNoteFileResponse> {
        const relPath = assertNoteRelPath(request.path);
        await this.assertWritableTarget(relPath);
        await this.assertContentSize(request.content);
        const target = resolveNotePath(this.root, relPath);
        if (request.baseRevision && this.fs.existsSync(target)) {
            const current = await this.readFile(relPath);
            if (current.revision !== request.baseRevision) {
                throw notePathError(409, 'note_revision_conflict', 'note changed since it was loaded');
            }
        }
        await this.fs.writeFile(target, request.content, 'utf8');
        return await this.readFile(relPath);
    }

    async createFolder(path: string): Promise<{ path: string }> {
        const relPath = assertNoteFolderRelPath(path);
        await this.ensureRoot();
        const parent = parentRelPath(relPath);
        if (parent) await this.existingFolderPath(parent);
        const target = resolveNotePath(this.root, relPath);
        if (this.fs.existsSync(target)) {
            throw notePathError(409, 'note_path_exists', 'note folder already exists');
        }
        await this.fs.mkdir(target);
        return { path: relPath };
    }

    async rename(from: string, to: string): Promise<{ from: string; to: string }> {
        const fromRel = this.assertRenameRelPath(from);
        const renamingFile = fromRel.endsWith(NOTE_FILE_EXT);
        const toRel = renamingFile ? assertNoteRelPath(to) : assertNoteFolderRelPath(to);
        const source = renamingFile
            ? await this.existingFilePath(fromRel)
            : await this.existingFolderPath(fromRel);
        if (!renamingFile && toRel.startsWith(`${fromRel}/`)) {
            throw notePathError(400, 'invalid_note_path', 'note folder cannot be moved into itself');
        }
        await this.assertWritableTarget(toRel);
        const target = resolveNotePath(this.root, toRel);
        if (this.fs.existsSync(target)) {
            throw notePathError(409, 'note_path_exists', 'note target already exists');
        }
        await this.fs.rename(source, target);
        return { from: fromRel, to: toRel };
    }

    private assertRenameRelPath(input: unknown): string {
        try {
            return assertNoteRelPath(input);
        } catch (fileError) {
            try {
                return assertNoteFolderRelPath(input);
            } catch {
                throw fileError;
            }
        }
    }

    private async ensureRoot(): Promise<void> {
        await this.fs.mkdir(this.root, { recursive: true });
    }

    private async listFolder(relFolder: string): Promise<DashboardNoteTreeEntry[]> {
        const folder = relFolder ? resolveNotePath(this.root, relFolder) : this.root;
        const entries = await this.fs.readdir(folder, { withFileTypes: true });
        const result: DashboardNoteTreeEntry[] = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const relPath = relFolder ? `${relFolder}/${entry.name}` : entry.name;
            const target = resolveNotePath(this.root, relPath);
            const entryStat = await this.fs.lstat(target);
            if (entryStat.isSymbolicLink()) continue;
            if (entryStat.isDirectory()) {
                result.push({
                    path: relPath,
                    name: entry.name,
                    kind: 'folder',
                    mtimeMs: entryStat.mtimeMs,
                    size: 0,
                    children: await this.listFolder(relPath),
                });
                continue;
            }
            if (entryStat.isFile() && entry.name.endsWith('.md')) {
                result.push({
                    path: relPath,
                    name: entry.name,
                    kind: 'file',
                    mtimeMs: entryStat.mtimeMs,
                    size: entryStat.size,
                });
            }
        }
        return result.sort((a, b) => a.kind === b.kind
            ? a.name.localeCompare(b.name)
            : a.kind === 'folder' ? -1 : 1);
    }

    private async existingFilePath(relPath: string): Promise<string> {
        await this.ensureRoot();
        const target = resolveNotePath(this.root, relPath);
        if (!this.fs.existsSync(target)) {
            throw notePathError(404, 'note_not_found', 'note file does not exist');
        }
        await assertNotSymlink(target);
        await assertRealPathInside(this.root, target);
        const fileStat = await this.fs.stat(target);
        if (!fileStat.isFile()) {
            throw notePathError(400, 'note_not_file', 'note path must be a file');
        }
        return target;
    }

    private async existingFolderPath(relPath: string): Promise<string> {
        const folder = resolveNotePath(this.root, relPath);
        if (!this.fs.existsSync(folder)) {
            throw notePathError(404, 'note_not_found', 'note folder does not exist');
        }
        await assertNotSymlink(folder);
        await assertRealPathInside(this.root, folder);
        const folderStat = await this.fs.stat(folder);
        if (!folderStat.isDirectory()) {
            throw notePathError(400, 'note_not_folder', 'note path must be a folder');
        }
        return folder;
    }

    private async assertWritableTarget(relPath: string): Promise<void> {
        await this.ensureRoot();
        const target = resolveNotePath(this.root, relPath);
        const parent = dirname(target);
        if (!this.fs.existsSync(parent)) {
            throw notePathError(404, 'note_parent_missing', 'note parent folder does not exist');
        }
        await assertNotSymlink(parent);
        await assertRealPathInside(this.root, parent);
    }

    private async assertContentSize(content: string): Promise<void> {
        if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
            throw notePathError(413, 'note_payload_too_large', 'note content exceeds the maximum supported size');
        }
    }

    private fileResponse(
        relPath: string,
        content: string,
        mtimeMs: number,
        size: number,
    ): DashboardNoteFileResponse {
        const revision = createHash('sha256')
            .update(content)
            .update(String(mtimeMs))
            .update(String(size))
            .digest('hex');
        return {
            path: relPath,
            name: basename(relPath),
            content,
            revision,
            mtimeMs,
            size,
        };
    }
}
