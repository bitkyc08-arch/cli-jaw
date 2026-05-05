import fs from 'fs';
import os from 'os';
import { join, relative } from 'path';
import Database from 'better-sqlite3';
import { JAW_HOME, settings } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';
import { instanceId } from '../core/instance.js';
import { getMemory, getRecentMessages } from '../core/db.js';

// Re-export everything from sub-modules for backward compatibility
export {
    type BootstrapOptions,
    type AdvancedMeta,
    type SearchHit,
    type ParsedMarkdown,
    DEFAULT_IMPORTED_COUNTS,
    getAdvancedMemoryDir,
    getAdvancedMemoryBackupDir,
    getAdvancedFlushFilePath,
    getAdvancedIndexDbPath,
    getLegacyAdvancedMemoryDir,
    ensureDir,
    safeReadFile,
    writeText,
    frontmatter,
    hashText,
    sanitizeKeywords,
    listMarkdownFiles,
    countMarkdownFiles,
    countFiles,
    readMeta,
    writeMeta,
} from './shared.js';

export {
    normalizeOpenAiCompatibleBaseUrl,
    expandSearchKeywords,
    validateAdvancedMemoryConfig,
    getLastExpansionTerms,
} from './keyword-expand.js';

export {
    reindexAll,
    reindexSingleFile,
    reindexIntegratedMemoryFile,
    searchIndex,
    formatHits,
    reindexIndexCounts,
    getIndexDb,
    indexedFiles,
} from './indexing.js';

export {
    syncLegacyMarkdownShadowImport,
    syncKvShadowImport,
    syncCoreProfile,
    ensureAdvancedMemoryStructure,
    bootstrapAdvancedMemory,
} from './bootstrap.js';

import {
    getAdvancedMemoryDir,
    getAdvancedMemoryBackupDir,
    getAdvancedIndexDbPath,
    getLegacyAdvancedMemoryDir,
    safeReadFile,
    writeText,
    frontmatter,
    listMarkdownFiles,
    countFiles,
    readMeta,
    writeMeta,
} from './shared.js';

import { getLastExpansionTerms } from './keyword-expand.js';
import { reindexAll, searchIndex, formatHits, reindexIndexCounts, reindexIntegratedMemoryFile } from './indexing.js';
import { ensureAdvancedMemoryStructure, bootstrapAdvancedMemory, syncCoreProfile, scanSystemProfile } from './bootstrap.js';
import { reflectRecentEpisodes, type ReflectionResult } from './reflect.js';

// ---------- Public API ----------

export function reindexAdvancedMemory() {
    const root = getAdvancedMemoryDir();
    ensureAdvancedMemoryStructure();
    return reindexAll(root);
}

export function syncIntegratedCoreMemory() {
    const root = getAdvancedMemoryDir();
    return syncCoreProfile(root);
}

export function listAdvancedMemoryFiles() {
    const root = getAdvancedMemoryDir();
    return {
        root,
        sections: {
            profile: fs.existsSync(join(root, 'profile.md')) ? ['profile.md'] : [],
            shared: listMarkdownFiles(join(root, 'shared')).map(f => relative(root, f).replace(/\\/g, '/')),
            episodes: listMarkdownFiles(join(root, 'episodes')).map(f => relative(root, f).replace(/\\/g, '/')),
            semantic: listMarkdownFiles(join(root, 'semantic')).map(f => relative(root, f).replace(/\\/g, '/')),
            procedures: listMarkdownFiles(join(root, 'procedures')).map(f => relative(root, f).replace(/\\/g, '/')),
            sessions: listMarkdownFiles(join(root, 'sessions')).map(f => relative(root, f).replace(/\\/g, '/')),
            corrupted: listMarkdownFiles(join(root, 'corrupted')).map(f => relative(root, f).replace(/\\/g, '/')),
            legacyUnmapped: listMarkdownFiles(join(root, 'legacy-unmapped')).map(f => relative(root, f).replace(/\\/g, '/')),
        },
    };
}

export function searchAdvancedMemory(query: string | string[]) {
    const terms = Array.isArray(query)
        ? query.map(v => String(v || '').trim()).filter(Boolean)
        : [String(query || '').trim()].filter(Boolean);
    const baseQuery = terms[0] || '';
    const expanded = terms.length > 1 ? terms.slice(1) : undefined;
    const { hits } = searchIndex(baseQuery, expanded);
    return formatHits(hits);
}

function parseMarkdownFileLight(raw: string) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') return { body: raw };
    const closing = lines.findIndex((line, idx) => idx > 0 && line === '---');
    if (closing === -1) return { body: raw };
    return { body: lines.slice(closing + 1).join('\n') };
}

export function loadAdvancedProfileSummary(maxChars = 800) {
    const file = join(getAdvancedMemoryDir(), 'profile.md');
    if (!fs.existsSync(file)) return '';
    const { body } = parseMarkdownFileLight(safeReadFile(file));
    const trimmed = body.trim();
    if (!trimmed) return '';
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + '\n...(truncated)' : trimmed;
}

export function loadSoulSummary(maxChars = 1000): string {
    const file = join(getAdvancedMemoryDir(), 'shared', 'soul.md');
    if (!fs.existsSync(file)) return '';
    const { body } = parseMarkdownFileLight(safeReadFile(file));
    const trimmed = body.trim();
    if (!trimmed) return '';
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + '\n...(truncated)' : trimmed;
}

export function hasSoulFile(): boolean {
    return fs.existsSync(join(getAdvancedMemoryDir(), 'shared', 'soul.md'));
}

function diversifyHits(
    hits: Array<{ kind: string; relpath: string; [k: string]: unknown }>,
    opts: { maxPerKind?: Record<string, number>; maxPerRelpath?: number } = {},
) {
    const maxPerKind = opts.maxPerKind || { episode: 2, profile: 1, semantic: 1, shared: 1, procedure: 1 };
    const maxPerRelpath = opts.maxPerRelpath ?? 1;
    const kindCount: Record<string, number> = {};
    const relpathCount: Record<string, number> = {};
    return hits.filter(hit => {
        const kc = kindCount[hit.kind] || 0;
        const rc = relpathCount[hit.relpath] || 0;
        const kindLimit = maxPerKind[hit.kind] ?? 2;
        if (kc >= kindLimit || rc >= maxPerRelpath) return false;
        kindCount[hit.kind] = kc + 1;
        relpathCount[hit.relpath] = rc + 1;
        return true;
    });
}

export function buildTaskSnapshot(query: string | string[], budget = 2800, expanded?: string[]) {
    const terms = Array.isArray(query)
        ? query.map(v => String(v || '').trim()).filter(Boolean)
        : [String(query || '').trim()].filter(Boolean);
    let cleaned = terms[0] || '';
    if (!cleaned) return '';

    // Phase 53-B: When the prompt is very short (e.g. "okay", "go", "yes"),
    // supplement with keywords from recent DB messages so the snapshot
    // returns meaningful context instead of empty.
    if (cleaned.length < 20) {
        try {
            const wd = settings.workingDir || null;
            const rows = (getRecentMessages.all(wd, 5) as Array<{ role?: string; content?: string }>) || [];
            const recentText = rows
                .filter(r => r.role === 'user' || r.role === 'assistant')
                .map(r => String(r.content || '').slice(0, 200))
                .join(' ');
            if (recentText.length > 10) {
                cleaned = `${cleaned} ${recentText}`.slice(0, 500);
            }
        } catch { /* DB not ready */ }
    }

    const mergedExpanded = expanded?.length ? expanded : (terms.length > 1 ? terms.slice(1) : undefined);
    const { hits } = searchIndex(cleaned, mergedExpanded);
    if (!hits.length) return '';

    const diversified = diversifyHits(hits);
    const out: string[] = [];
    let remaining = Math.max(0, budget);

    for (const hit of diversified.slice(0, 4)) {
        if (remaining <= 0) break;
        const header = `### ${hit.relpath}:${hit.source_start_line}-${hit.source_end_line}`;
        const snippetBudget = Math.min(700, Math.max(0, remaining - header.length - 4));
        if (snippetBudget <= 0) break;
        const snippet = String(hit.snippet ?? '').slice(0, snippetBudget).trim();
        const block = `${header}\n${snippet}`;
        out.push(block);
        remaining -= block.length + 2;
    }

    if (!out.length) return '';
    return `## Task Snapshot\n${out.join('\n\n')}`;
}

export async function buildTaskSnapshotAsync(query: string | string[], budget = 2800) {
    return buildTaskSnapshot(query, budget);
}

export function readAdvancedMemorySnippet(relPath: string, opts: { lines?: string } = {}) {
    const root = getAdvancedMemoryDir();
    const file = join(root, relPath);
    if (!fs.existsSync(file)) return null;
    const content = safeReadFile(file);
    if (opts.lines) {
        const parts = String(opts.lines).split('-').map(Number);
        const fromRaw = parts[0];
        const toRaw = parts[1];
        const from = Number.isFinite(fromRaw) && (fromRaw as number) > 0 ? (fromRaw as number) : 1;
        const to = Number.isFinite(toRaw) && (toRaw as number) >= from ? (toRaw as number) : from;
        return content.split('\n').slice(from - 1, to).join('\n');
    }
    return content;
}

export function getAdvancedMemoryStatus() {
    const root = getAdvancedMemoryDir();
    const meta = readMeta();
    const initialized = !!meta;
    const enabled = true;
    const provider = 'integrated';
    const corruptedDir = join(root, 'corrupted');
    const dbPath = getAdvancedIndexDbPath();
    const indexReady = fs.existsSync(dbPath);
    const indexed = indexReady ? reindexIndexCounts(dbPath) : { totalFiles: 0, totalChunks: 0 };

    return {
        phase: meta?.phase || '10',
        enabled,
        provider,
        state: initialized ? 'configured' : 'not_initialized',
        initialized,
        storageRoot: root,
        routing: {
            searchRead: indexReady ? 'advanced' : 'basic',
            save: 'integrated',
        },
        indexState: initialized ? (indexReady ? 'ready' : 'not_indexed') : 'not_initialized',
        indexedFiles: indexed.totalFiles,
        indexedChunks: indexed.totalChunks,
        lastIndexedAt: fs.existsSync(dbPath) ? fs.statSync(dbPath).mtime.toISOString() : null,
        importStatus: meta?.bootstrapStatus || (initialized ? 'idle' : 'not_started'),
        corruptedCount: countFiles(corruptedDir),
        lastExpansion: getLastExpansionTerms(),
        lastError: meta?.lastError || '',
        importedCounts: meta?.importedCounts || { core: 0, markdown: 0, kv: 0, claude: 0 },
        backupRoot: getAdvancedMemoryBackupDir(),
    };
}

function getLegacyClaudeMemoryDir() {
    const wd = expandHomePath(settings.workingDir || os.homedir(), os.homedir());
    const hash = wd.replace(/[\\/]/g, '-');
    return join(os.homedir(), '.claude', 'projects', hash, 'memory');
}

export function ensureIntegratedMemoryReady() {
    const created = ensureAdvancedMemoryStructure();
    syncCoreProfile(getAdvancedMemoryDir(), { force: false });
    const status = getAdvancedMemoryStatus();
    const meta = readMeta();
    const alreadyBootstrapped = meta?.bootstrapStatus === 'done';
    if (status.indexState === 'ready' && alreadyBootstrapped) return { created, bootstrapped: false, status };
    const hasLegacy = fs.existsSync(join(JAW_HOME, 'memory', 'MEMORY.md'))
        || fs.existsSync(join(JAW_HOME, 'memory', 'daily'))
        || fs.existsSync(getLegacyClaudeMemoryDir())
        || (getMemory.all() as unknown[]).length > 0
        || fs.existsSync(getLegacyAdvancedMemoryDir());
    if (!hasLegacy) {
        // No legacy data — seed profile from hardware/project scan
        const root = getAdvancedMemoryDir();
        const profilePath = join(root, 'profile.md');
        const profileContent = safeReadFile(profilePath);
        // Only overwrite if profile was auto-generated and has no real content
        const isEmptyProfile = !profileContent
            || (profileContent.includes('source: generated') && !profileContent.includes('- '));
        if (isEmptyProfile) {
            const systemInfo = scanSystemProfile();
            const fm = frontmatter({
                id: `profile-${instanceId()}`,
                home_id: instanceId(),
                kind: 'profile',
                source: 'system-scan',
                trust_level: 'high',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            writeText(profilePath, fm + `# Profile\n\n${systemInfo}\n`);
            console.log('[jaw:bootstrap] seeded profile from system scan (no legacy data found)');
        }
        const result = reindexAll(root);
        writeMeta({ bootstrapStatus: 'done', lastBootstrapAt: new Date().toISOString() });
        return { created, bootstrapped: false, status: getAdvancedMemoryStatus(), result };
    }
    const result = bootstrapAdvancedMemory({
        importCore: true,
        importMarkdown: true,
        importKv: true,
        importClaudeSession: true,
    });
    return { created, bootstrapped: true, status: getAdvancedMemoryStatus(), result };
}

// ---------- Phase 4: Reflection ----------

function writeReflectMeta(meta: { lastReflectedAt: string }) {
    const metaPath = join(getAdvancedMemoryDir(), '.reflect-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export function getLastReflectedAt(): string | null {
    const metaPath = join(getAdvancedMemoryDir(), '.reflect-meta.json');
    try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        return raw.lastReflectedAt || null;
    } catch (err) {
        if (fs.existsSync(metaPath)) {
            console.warn('[jaw:reflect-meta] failed to read', (err as Error).message);
        }
        return null;
    }
}

export function reflectMemory(options?: { sinceDays?: number; dryRun?: boolean }): ReflectionResult {
    const result = reflectRecentEpisodes(options);
    for (const changed of result.changedFiles) {
        reindexIntegratedMemoryFile(changed);
    }
    if (!options?.dryRun && result.changedFiles.length > 0) {
        writeReflectMeta({ lastReflectedAt: new Date().toISOString() });
    }
    return result;
}

// ---------- Backward-compat aliases ----------
export {
    getAdvancedMemoryDir as getStructuredMemoryDir,
    getAdvancedMemoryBackupDir as getMemoryBackupDir,
    getAdvancedFlushFilePath as getMemoryFlushFilePath,
} from './shared.js';

export {
    ensureAdvancedMemoryStructure as ensureMemoryStructure,
    bootstrapAdvancedMemory as bootstrapMemory,
} from './bootstrap.js';

export {
    ensureIntegratedMemoryReady as ensureMemoryRuntimeReady,
    reindexAdvancedMemory as reindexMemory,
    listAdvancedMemoryFiles as listMemoryFiles,
    searchAdvancedMemory as searchIndexedMemory,
    readAdvancedMemorySnippet as readIndexedMemorySnippet,
    getAdvancedMemoryStatus as getMemoryStatus,
    loadAdvancedProfileSummary as loadProfileSummary,
};
