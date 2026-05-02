import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
    lstat,
    mkdir,
    readFile,
    realpath,
    stat,
    writeFile,
} from 'node:fs/promises';
import { extname } from 'node:path';
import { posix } from 'node:path';
import { dashboardPath } from '../dashboard-home.js';
import type { DashboardNoteAssetResponse } from '../types.js';
import {
    assertNoteRelPath,
    assertNotSymlink,
    assertRealPathInside,
    isPathInside,
    notePathError,
    resolveNotePath,
} from './path-guards.js';

export const NOTES_ASSET_ROOT = '.assets';
export const MAX_NOTE_ASSET_BYTES = 5 * 1024 * 1024;
export const NOTE_ASSET_JSON_LIMIT = '8mb';

const ALLOWED_NOTE_ASSET_TYPES = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
} as const;

type AllowedNoteAssetMime = keyof typeof ALLOWED_NOTE_ASSET_TYPES;

export type SaveNoteAssetRequest = {
    notePath: string;
    mime: string;
    dataBase64: string;
};

export type ResolvedNoteAsset = {
    path: string;
    absolutePath: string;
    mime: AllowedNoteAssetMime;
    size: number;
};

type NotesAssetStoreFs = {
    existsSync: typeof existsSync;
    lstat: typeof lstat;
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    realpath: typeof realpath;
    stat: typeof stat;
    writeFile: typeof writeFile;
};

export type NotesAssetStoreOptions = {
    notesRoot?: string;
    fsImpl?: NotesAssetStoreFs;
    clock?: () => Date;
    id?: () => string;
};

const DEFAULT_FS: NotesAssetStoreFs = {
    existsSync,
    lstat,
    mkdir,
    readFile,
    realpath,
    stat,
    writeFile,
};

function assertAllowedMime(mime: string): AllowedNoteAssetMime {
    if (Object.hasOwn(ALLOWED_NOTE_ASSET_TYPES, mime)) return mime as AllowedNoteAssetMime;
    throw notePathError(415, 'note_asset_unsupported_type', 'Unsupported note asset type.');
}

function decodeBase64(input: string): Buffer {
    if (!input || /\s/.test(input) || input.length % 4 !== 0) {
        throw notePathError(400, 'note_asset_invalid_base64', 'Asset data must be canonical base64.');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
        throw notePathError(400, 'note_asset_invalid_base64', 'Asset data must be canonical base64.');
    }
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length === 0) {
        throw notePathError(400, 'note_asset_invalid_base64', 'Asset data must not be empty.');
    }
    if (decoded.length > MAX_NOTE_ASSET_BYTES) {
        throw notePathError(413, 'note_asset_too_large', 'Asset exceeds the maximum supported size.');
    }
    return decoded;
}

function detectMime(buffer: Buffer): AllowedNoteAssetMime | null {
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    const gifHeader = buffer.subarray(0, 6).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
        return 'image/gif';
    }
    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

function slugForNotePath(notePath: string): string {
    return notePath
        .replace(/\.md$/i, '')
        .split('/')
        .join('__')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 120) || 'note';
}

function timestampFor(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function normalizeAssetRelPath(input: string): string {
    if (typeof input !== 'string') {
        throw notePathError(400, 'invalid_note_asset_path', 'asset path must be a string');
    }
    const trimmed = input.trim().replace(/^\.\//, '');
    if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) {
        throw notePathError(400, 'invalid_note_asset_path', 'asset path is invalid');
    }
    if (trimmed.startsWith('/') || !trimmed.startsWith(`${NOTES_ASSET_ROOT}/`)) {
        throw notePathError(400, 'invalid_note_asset_path', 'asset path must stay under .assets');
    }
    const normalized = posix.normalize(trimmed);
    if (normalized !== trimmed || normalized.startsWith('../') || normalized.includes('/../')) {
        throw notePathError(400, 'invalid_note_asset_path', 'asset path cannot escape notes root');
    }
    if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw notePathError(400, 'invalid_note_asset_path', 'asset path contains invalid segments');
    }
    const ext = extname(normalized).toLowerCase();
    if (!Object.values(ALLOWED_NOTE_ASSET_TYPES).includes(ext as '.png')) {
        throw notePathError(415, 'note_asset_unsupported_type', 'Unsupported note asset type.');
    }
    return normalized;
}

function mimeForExtension(path: string): AllowedNoteAssetMime {
    const ext = extname(path).toLowerCase();
    const entry = Object.entries(ALLOWED_NOTE_ASSET_TYPES)
        .find(([, expectedExt]) => expectedExt === ext);
    if (!entry) throw notePathError(415, 'note_asset_unsupported_type', 'Unsupported note asset type.');
    return entry[0] as AllowedNoteAssetMime;
}

export class NotesAssetStore {
    private readonly root: string;
    private readonly fs: NotesAssetStoreFs;
    private readonly clock: () => Date;
    private readonly id: () => string;

    constructor(options: NotesAssetStoreOptions = {}) {
        this.root = options.notesRoot || dashboardPath('notes');
        this.fs = options.fsImpl || DEFAULT_FS;
        this.clock = options.clock || (() => new Date());
        this.id = options.id || randomUUID;
    }

    rootPath(): string {
        return this.root;
    }

    async saveAsset(request: SaveNoteAssetRequest): Promise<DashboardNoteAssetResponse> {
        const notePath = assertNoteRelPath(request.notePath);
        const declaredMime = assertAllowedMime(request.mime);
        const bytes = decodeBase64(request.dataBase64);
        const detectedMime = detectMime(bytes);
        if (!detectedMime || detectedMime !== declaredMime) {
            throw notePathError(415, 'note_asset_mime_mismatch', 'Asset MIME does not match its content.');
        }
        const ext = ALLOWED_NOTE_ASSET_TYPES[detectedMime];
        const assetRootRel = NOTES_ASSET_ROOT;
        const slug = slugForNotePath(notePath);
        const fileName = `${timestampFor(this.clock())}-${this.id()}${ext}`;
        const relPath = `${assetRootRel}/${slug}/${fileName}`;
        const assetRoot = resolveNotePath(this.root, assetRootRel);
        const assetFolder = resolveNotePath(this.root, `${assetRootRel}/${slug}`);
        const target = resolveNotePath(this.root, relPath);

        await this.fs.mkdir(this.root, { recursive: true });
        await this.ensureDirectoryNotSymlink(assetRoot);
        await this.ensureDirectoryNotSymlink(assetFolder);
        await assertRealPathInside(this.root, assetFolder);

        try {
            await this.fs.writeFile(target, bytes, { flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw notePathError(409, 'note_asset_collision', 'Asset filename already exists.');
            }
            throw error;
        }
        await assertNotSymlink(target);
        await assertRealPathInside(this.root, target);
        return {
            ok: true,
            path: relPath,
            markdown: `![pasted image](./${relPath})`,
            mime: detectedMime,
            size: bytes.length,
        };
    }

    async resolveAsset(path: string): Promise<ResolvedNoteAsset> {
        const relPath = normalizeAssetRelPath(path);
        const target = resolveNotePath(this.root, relPath);
        if (!this.fs.existsSync(target)) {
            throw notePathError(404, 'note_asset_not_found', 'Asset does not exist.');
        }
        await this.assertAssetPathComponentsNotSymlink(relPath);
        const [realRoot, realTarget] = await Promise.all([this.fs.realpath(this.root), this.fs.realpath(target)]);
        if (!isPathInside(realRoot, realTarget)) {
            throw notePathError(400, 'note_asset_path_escape', 'Asset path escapes notes root.');
        }
        const fileStat = await this.fs.stat(target);
        if (!fileStat.isFile()) {
            throw notePathError(400, 'note_asset_not_file', 'Asset path must be a file.');
        }
        if (fileStat.size > MAX_NOTE_ASSET_BYTES) {
            throw notePathError(413, 'note_asset_too_large', 'Asset exceeds the maximum supported size.');
        }
        const expectedMime = mimeForExtension(relPath);
        const detectedMime = detectMime(await this.fs.readFile(target));
        if (detectedMime !== expectedMime) {
            throw notePathError(415, 'note_asset_mime_mismatch', 'Asset MIME does not match its content.');
        }
        return {
            path: relPath,
            absolutePath: target,
            mime: expectedMime,
            size: fileStat.size,
        };
    }

    private async ensureDirectoryNotSymlink(path: string): Promise<void> {
        if (!this.fs.existsSync(path)) {
            await this.fs.mkdir(path, { recursive: true });
        }
        const entry = await this.fs.lstat(path);
        if (entry.isSymbolicLink()) {
            throw notePathError(400, 'note_asset_symlink_rejected', 'Asset symlinks are not supported.');
        }
        if (!entry.isDirectory()) {
            throw notePathError(400, 'note_asset_not_folder', 'Asset path must be a folder.');
        }
    }

    private async assertAssetPathComponentsNotSymlink(relPath: string): Promise<void> {
        const segments = relPath.split('/');
        for (let index = 1; index <= segments.length; index += 1) {
            const current = resolveNotePath(this.root, segments.slice(0, index).join('/'));
            const entry = await this.fs.lstat(current);
            if (entry.isSymbolicLink()) {
                throw notePathError(400, 'note_asset_symlink_rejected', 'Asset symlinks are not supported.');
            }
        }
    }
}
