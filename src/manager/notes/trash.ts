import { existsSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dashboardPath } from '../dashboard-home.js';
import type { DashboardTrashNoteKind, DashboardTrashNoteResponse } from '../types.js';
import {
    assertNoteFolderRelPath,
    assertNoteRelPath,
    assertNotSymlink,
    assertRealPathInside,
    encodeTrashPath,
    notePathError,
    resolveNotePath,
} from './path-guards.js';
import { moveToSystemTrash } from './system-trash.js';

export type TrashDestination = 'os-trash' | 'dashboard-trash';

export type TrashAdapter = {
    moveToOsTrash(path: string): Promise<string>;
};

export type NotesTrashFs = {
    existsSync: typeof existsSync;
    mkdir: typeof mkdir;
    rename: typeof rename;
};

export type NotesTrashOptions = {
    dashboardHome?: string;
    adapter?: TrashAdapter;
    fsImpl?: NotesTrashFs;
};

const DEFAULT_FS: NotesTrashFs = {
    existsSync,
    mkdir,
    rename,
};

const DEFAULT_TRASH_ADAPTER: TrashAdapter = {
    async moveToOsTrash(path: string): Promise<string> {
        await moveToSystemTrash([path]);
        return path;
    },
};

export class NotesTrash {
    private readonly dashboardHome: string;
    private readonly adapter: TrashAdapter;
    private readonly fs: NotesTrashFs;

    constructor(options: NotesTrashOptions = {}) {
        this.dashboardHome = options.dashboardHome || dashboardPath();
        this.adapter = options.adapter || DEFAULT_TRASH_ADAPTER;
        this.fs = options.fsImpl || DEFAULT_FS;
    }

    async trashPath(
        root: string,
        relPathInput: string,
        kind: DashboardTrashNoteKind = 'file',
    ): Promise<DashboardTrashNoteResponse> {
        const relPath = kind === 'folder'
            ? assertNoteFolderRelPath(relPathInput)
            : assertNoteRelPath(relPathInput);
        const target = resolveNotePath(root, relPath);
        await assertNotSymlink(target);
        await assertRealPathInside(root, target);
        await this.assertTargetKind(target, kind);

        try {
            const restoreHint = await this.adapter.moveToOsTrash(target);
            return { path: relPath, kind, deletedTo: 'os-trash', restoreHint };
        } catch {
            return await this.moveToDashboardTrash(target, relPath, kind);
        }
    }

    async trashFile(root: string, relPathInput: string): Promise<DashboardTrashNoteResponse> {
        return await this.trashPath(root, relPathInput, 'file');
    }

    async trashFolder(root: string, relPathInput: string): Promise<DashboardTrashNoteResponse> {
        return await this.trashPath(root, relPathInput, 'folder');
    }

    private async assertTargetKind(target: string, kind: DashboardTrashNoteKind): Promise<void> {
        const targetStat = await stat(target);
        if (kind === 'folder' && !targetStat.isDirectory()) {
            throw notePathError(400, 'invalid_note_folder_path', 'folder path must reference a directory');
        }
        if (kind === 'file' && !targetStat.isFile()) {
            throw notePathError(400, 'invalid_note_path', 'note path must reference a file');
        }
    }

    private async moveToDashboardTrash(
        source: string,
        relPath: string,
        kind: DashboardTrashNoteKind,
    ): Promise<DashboardTrashNoteResponse> {
        const trashRoot = join(this.dashboardHome, '.trash', 'notes');
        await this.fs.mkdir(trashRoot, { recursive: true });
        const target = this.uniqueTrashPath(trashRoot, relPath);
        await this.fs.mkdir(dirname(target), { recursive: true });
        try {
            await this.fs.rename(source, target);
        } catch (error) {
            if (this.fs.existsSync(source)) {
                throw notePathError(500, 'note_trash_failed', (error as Error).message);
            }
            throw error;
        }
        return { path: relPath, kind, deletedTo: 'dashboard-trash', restoreHint: target };
    }

    private uniqueTrashPath(root: string, relPath: string): string {
        const encoded = encodeTrashPath(relPath);
        const base = `${Date.now()}__${encoded}`;
        let candidate = join(root, base);
        let suffix = 1;
        while (this.fs.existsSync(candidate)) {
            candidate = join(root, `${base}.${suffix}`);
            suffix += 1;
        }
        return candidate;
    }
}
