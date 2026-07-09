import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { dashboardPath } from '../dashboard-home.js';
import { confinePagePath, isSafeRelPath, isWritablePagePath } from './path-guards.js';
import { newDesignPageJson, validateDesignPageJson, type DesignPageJson } from './schema.js';
import { createDesignSnapshot, listDesignSnapshots, restoreDesignSnapshot, type DesignSnapshotInfo } from './snapshots.js';

/**
 * Filesystem-first design store (186 Phase 2).
 *
 * Layout: <dashboard-home>/design/projects/<project-key>/pages/<page-id>/
 *   page.json (source of truth) · artifact.html · prompt.md · assets/ · snapshots/
 *
 * The store is rebuildable from `page.json` scans; there is no separate index.
 * Schema failures keep the page and surface a warning — never delete.
 */

export type DesignPageSummary = {
    id: string;
    title: string;
    artifactKind: 'html';
    projectKey: string | null;
    updatedAt: string;
    revision: number;
    schemaWarning: string | null;
};

export type DesignPageDetail = DesignPageSummary & {
    createdAt: string;
    exportTarget: string | null;
};

export type DesignLocalPaths = {
    pageDir: string;
    artifactPath: string;
    promptPath: string;
};

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const STARTER_ARTIFACT = '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>New design page</title></head>\n<body>\n  <main style="font-family: system-ui; padding: 24px;">\n    <h1>New design page</h1>\n    <p>Edit artifact.html (agent direct write or jaw design files write) and reload.</p>\n  </main>\n</body>\n</html>\n';

let pageIdCounter = 0;

function designRoot(): string {
    return dashboardPath('design', 'projects');
}

/** Stable directory key for a bound projectDir: slug + short hash of the absolute path. */
export function projectKeyDirName(projectKey: string | null): string {
    if (!projectKey) return 'default';
    const abs = resolve(projectKey);
    const slug = basename(abs).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
    return `${slug}-${hash}`;
}

function pagesDirFor(projectKey: string | null): string {
    return join(designRoot(), projectKeyDirName(projectKey), 'pages');
}

type LocatedPage = {
    pageDir: string;
    raw: unknown | null;
    parseError: string | null;
};

function readPageJson(pageDir: string): LocatedPage {
    const path = join(pageDir, 'page.json');
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        return { pageDir, raw, parseError: null };
    } catch (error) {
        return { pageDir, raw: null, parseError: (error as Error).message };
    }
}

function listProjectDirs(): string[] {
    const root = designRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .map(name => join(root, name))
        .filter(path => { try { return statSync(path).isDirectory(); } catch { return false; } });
}

function listPageDirs(projectKey?: string | null | undefined): string[] {
    const projectDirs = projectKey === undefined ? listProjectDirs() : [join(designRoot(), projectKeyDirName(projectKey ?? null))];
    const pageDirs: string[] = [];
    for (const projectDir of projectDirs) {
        const pagesDir = join(projectDir, 'pages');
        if (!existsSync(pagesDir)) continue;
        for (const name of readdirSync(pagesDir)) {
            const dir = join(pagesDir, name);
            try { if (statSync(dir).isDirectory()) pageDirs.push(dir); } catch { /* skip */ }
        }
    }
    return pageDirs;
}

function summaryFrom(located: LocatedPage): DesignPageSummary {
    const fallbackId = basename(located.pageDir);
    if (located.raw !== null) {
        const validated = validateDesignPageJson(located.raw);
        if (validated.ok) {
            return {
                id: validated.page.id,
                title: validated.page.title,
                artifactKind: 'html',
                projectKey: validated.page.projectKey,
                updatedAt: validated.page.updatedAt,
                revision: validated.page.revision,
                schemaWarning: null,
            };
        }
        return { id: fallbackId, title: fallbackId, artifactKind: 'html', projectKey: null, updatedAt: new Date(0).toISOString(), revision: 0, schemaWarning: validated.error };
    }
    return { id: fallbackId, title: fallbackId, artifactKind: 'html', projectKey: null, updatedAt: new Date(0).toISOString(), revision: 0, schemaWarning: located.parseError ?? 'unreadable page.json' };
}

function locatePage(pageId: string): LocatedPage | null {
    if (!isSafeRelPath(pageId) || pageId.includes('/')) return null;
    for (const pageDir of listPageDirs()) {
        if (basename(pageDir) === pageId) return readPageJson(pageDir);
    }
    return null;
}

function requireValidPage(pageId: string): { page: DesignPageJson; pageDir: string } {
    const located = locatePage(pageId);
    if (!located) throw new Error(`design page not found: ${pageId}`);
    if (located.raw === null) throw new Error(`page.json unreadable for ${pageId}: ${located.parseError}`);
    const validated = validateDesignPageJson(located.raw);
    if (!validated.ok) throw new Error(`page.json invalid for ${pageId}: ${validated.error}`);
    return { page: validated.page, pageDir: located.pageDir };
}

function persistPageJson(pageDir: string, page: DesignPageJson): void {
    writeFileSync(join(pageDir, 'page.json'), `${JSON.stringify(page, null, 2)}\n`);
}

export function listDesignPages(projectKey?: string | null | undefined): DesignPageSummary[] {
    return listPageDirs(projectKey)
        .map(dir => summaryFrom(readPageJson(dir)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createDesignPage(input: { title: string; projectKey?: string | null }): DesignPageDetail {
    const title = input.title.trim();
    if (!title) throw new Error('title required');
    const projectKey = input.projectKey?.trim() || null;
    if (projectKey !== null && !isAbsolute(projectKey)) throw new Error('projectKey must be an absolute projectDir path');
    const id = `page-${Date.now().toString(36)}-${(++pageIdCounter).toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    const pageDir = join(pagesDirFor(projectKey), id);
    mkdirSync(join(pageDir, 'assets'), { recursive: true });
    mkdirSync(join(pageDir, 'snapshots'), { recursive: true });
    const page = newDesignPageJson({ id, title, projectKey });
    writeFileSync(join(pageDir, 'artifact.html'), STARTER_ARTIFACT);
    writeFileSync(join(pageDir, 'prompt.md'), `# ${title}\n`);
    persistPageJson(pageDir, page);
    return { ...summaryFrom(readPageJson(pageDir)), createdAt: page.createdAt, exportTarget: page.exportTarget } as DesignPageDetail;
}

export function getDesignPage(pageId: string): DesignPageDetail {
    const located = locatePage(pageId);
    if (!located) throw new Error(`design page not found: ${pageId}`);
    const summary = summaryFrom(located);
    if (located.raw !== null) {
        const validated = validateDesignPageJson(located.raw);
        if (validated.ok) {
            return { ...summary, createdAt: validated.page.createdAt, exportTarget: validated.page.exportTarget };
        }
    }
    return { ...summary, createdAt: summary.updatedAt, exportTarget: null };
}

export type DesignPatchResult =
    | { ok: true; page: DesignPageDetail }
    | { ok: false; conflict: true; currentRevision: number }
    | { ok: false; conflict?: false; error: string };

export function patchDesignPage(pageId: string, patch: { title?: string; exportTarget?: string | null }, baseRevision: number): DesignPatchResult {
    const { page, pageDir } = requireValidPage(pageId);
    if (page.revision !== baseRevision) return { ok: false, conflict: true, currentRevision: page.revision };
    if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) return { ok: false, error: 'title required' };
        page.title = title;
    }
    if (patch.exportTarget !== undefined) {
        if (patch.exportTarget !== null && !isSafeRelPath(patch.exportTarget)) return { ok: false, error: 'exportTarget must be a safe relative path' };
        page.exportTarget = patch.exportTarget;
    }
    page.revision += 1;
    page.updatedAt = new Date().toISOString();
    persistPageJson(pageDir, page);
    return { ok: true, page: getDesignPage(pageId) };
}

export function readDesignPageFile(pageId: string, rel: string): { content: string; revision: number } {
    const { page, pageDir } = requireValidPage(pageId);
    const path = confinePagePath(pageDir, rel);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`not a file: ${rel}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error('file too large');
    return { content: readFileSync(path, 'utf-8'), revision: page.revision };
}

export type DesignWriteResult =
    | { ok: true; revision: number }
    | { ok: false; conflict: true; currentRevision: number }
    | { ok: false; conflict?: false; error: string };

export function writeDesignPageFile(pageId: string, rel: string, content: string, baseRevision: number): DesignWriteResult {
    if (!isWritablePagePath(rel)) return { ok: false, error: `path not writable in v1: ${rel}` };
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) return { ok: false, error: 'content too large' };
    const { page, pageDir } = requireValidPage(pageId);
    if (page.revision !== baseRevision) return { ok: false, conflict: true, currentRevision: page.revision };
    if (rel === 'page.json') {
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch (error) { return { ok: false, error: `invalid json: ${(error as Error).message}` }; }
        const validated = validateDesignPageJson(parsed);
        if (!validated.ok) return { ok: false, error: `schema: ${validated.error}` };
        if (validated.page.id !== page.id) return { ok: false, error: 'page.json id must not change' };
    }
    const path = confinePagePath(pageDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (rel !== 'page.json') {
        page.revision += 1;
        page.updatedAt = new Date().toISOString();
        persistPageJson(pageDir, page);
        return { ok: true, revision: page.revision };
    }
    return { ok: true, revision: (JSON.parse(content) as DesignPageJson).revision };
}

export function localPathsForPage(pageId: string): DesignLocalPaths {
    const { pageDir } = requireValidPage(pageId);
    return {
        pageDir,
        artifactPath: join(pageDir, 'artifact.html'),
        promptPath: join(pageDir, 'prompt.md'),
    };
}

export function rescanDesignPages(projectKey?: string | null | undefined): { scanned: number; warnings: number } {
    const summaries = listDesignPages(projectKey);
    return { scanned: summaries.length, warnings: summaries.filter(s => s.schemaWarning !== null).length };
}

export type DesignExportResult =
    | { ok: true; exportedTo: string }
    | { ok: false; error: string };

export function exportDesignPage(pageId: string, target?: string, options: { overwrite?: boolean } = {}): DesignExportResult {
    const { page, pageDir } = requireValidPage(pageId);
    if (!page.projectKey) return { ok: false, error: 'page has no bound projectDir; set projectKey first' };
    const projectRoot = resolve(page.projectKey);
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
        return { ok: false, error: `bound projectDir missing: ${projectRoot}` };
    }
    const slug = page.title.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || page.id;
    const rel = target ?? page.exportTarget ?? `design/${slug}.html`;
    if (!isSafeRelPath(rel)) return { ok: false, error: `export target must be a safe relative path: ${rel}` };
    const destination = resolve(join(projectRoot, rel));
    if (destination !== projectRoot && !destination.startsWith(projectRoot + sep)) {
        return { ok: false, error: 'export target escapes the projectDir' };
    }
    if (existsSync(destination) && options.overwrite !== true) {
        return { ok: false, error: `export target exists (pass overwrite): ${rel}` };
    }
    const artifact = readFileSync(join(pageDir, 'artifact.html'), 'utf-8');
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, artifact);
    page.exportTarget = rel;
    page.revision += 1;
    page.updatedAt = new Date().toISOString();
    persistPageJson(pageDir, page);
    return { ok: true, exportedTo: destination };
}

export function snapshotDesignPage(pageId: string, label: 'before' | 'after' | 'recovery' | 'manual'): DesignSnapshotInfo {
    const { pageDir } = requireValidPage(pageId);
    return createDesignSnapshot(pageDir, label);
}

export function listDesignPageSnapshots(pageId: string): DesignSnapshotInfo[] {
    const { pageDir } = requireValidPage(pageId);
    return listDesignSnapshots(pageDir);
}

export function restoreDesignPageSnapshot(pageId: string, snapshotId: string): { ok: true; recoverySnapshot: string } | { ok: false; error: string } {
    const { page, pageDir } = requireValidPage(pageId);
    const recovery = createDesignSnapshot(pageDir, 'recovery');
    const restored = restoreDesignSnapshot(pageDir, snapshotId);
    if (!restored.ok) return restored;
    // Restoring artifact content is a content change: bump the revision so
    // concurrent editors see a conflict instead of silently diverging.
    const fresh = requireValidPage(pageId);
    fresh.page.revision = Math.max(fresh.page.revision, page.revision) + 1;
    fresh.page.updatedAt = new Date().toISOString();
    persistPageJson(pageDir, fresh.page);
    return { ok: true, recoverySnapshot: recovery.id };
}
