import fs from 'fs';
import os from 'os';
import { join, relative } from 'path';
import { JAW_HOME, settings } from '../core/config.js';
import { instanceId } from '../core/instance.js';
import { getMemory } from '../core/db.js';
import {
    type BootstrapOptions,
    type AdvancedMeta,
    DEFAULT_IMPORTED_COUNTS,
    getLegacyAdvancedMemoryDir,
    getAdvancedMemoryDir,
    ensureDir,
    safeReadFile,
    writeText,
    frontmatter,
    hashText,
    listMarkdownFiles,
    countMarkdownFiles,
    getMetaPath,
    readMeta,
    writeMeta,
    withMigrationLock,
} from './shared.js';
import { reindexAll, reindexSingleFile } from './indexing.js';

function slug(value: string) {
    return value
        .replace(/\\/g, '/')
        .replace(/[^a-zA-Z0-9._/-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function migrateLegacyAdvancedRoot(root: string) {
    const oldRoot = getLegacyAdvancedMemoryDir();
    if (!fs.existsSync(oldRoot) || oldRoot === root) return false;
    const newExists = fs.existsSync(root) && fs.readdirSync(root).length > 0;
    if (newExists) return false;
    ensureDir(join(root, '..'));
    fs.cpSync(oldRoot, root, { recursive: true });
    writeMeta({
        migrationVersion: 1,
        migrationState: 'done',
        migratedAt: new Date().toISOString(),
        sourceLayout: 'advanced',
    });
    return true;
}

function parseLegacyMemorySections(content: string) {
    const sections = {
        userPreferences: '',
        keyDecisions: '',
        activeProjects: '',
    };
    const patterns = [
        { key: 'userPreferences', re: /## User Preferences([\s\S]*?)(?=\n## |\s*$)/i },
        { key: 'keyDecisions', re: /## Key Decisions([\s\S]*?)(?=\n## |\s*$)/i },
        { key: 'activeProjects', re: /## Active Projects([\s\S]*?)(?=\n## |\s*$)/i },
    ] as const;
    for (const p of patterns) {
        const match = p.re.exec(content);
        if (match?.[1]) sections[p.key] = match[1].trim();
    }
    return sections;
}

function getLegacyClaudeMemoryDir() {
    const wd = (settings.workingDir || os.homedir()).replace(/^~/, os.homedir());
    const hash = wd.replace(/\//g, '-');
    return join(os.homedir(), '.claude', 'projects', hash, 'memory');
}

function importCoreMemory(root: string) {
    const corePath = join(JAW_HOME, 'memory', 'MEMORY.md');
    if (!fs.existsSync(corePath)) return 0;
    const profilePath = join(root, 'profile.md');
    if (fs.existsSync(profilePath)) {
        return 0;
    }
    const content = safeReadFile(corePath);
    const parsed = parseLegacyMemorySections(content);
    const body = `# Profile

## User Preferences
${parsed.userPreferences || ''}

## Key Decisions
${parsed.keyDecisions || ''}

## Active Projects
${parsed.activeProjects || ''}
`;
    const fm = frontmatter({
        id: `profile-${instanceId()}`,
        home_id: instanceId(),
        kind: 'profile',
        source: 'legacy-memory-md',
        trust_level: 'high',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });
    writeText(profilePath, fm + body);
    return 1;
}

// Phase 1: idempotent core sync (replaces one-shot importCoreMemory for ongoing changes)
export function syncCoreProfile(root: string, opts: { force?: boolean } = {}) {
    const corePath = join(JAW_HOME, 'memory', 'MEMORY.md');
    if (!fs.existsSync(corePath)) return { updated: false, reason: 'missing_core' as const };

    const profilePath = join(root, 'profile.md');
    const coreContent = safeReadFile(corePath);
    const sourceHash = hashText(coreContent);

    if (!opts.force) {
        const existing = fs.existsSync(profilePath) ? safeReadFile(profilePath) : '';
        if (existing.includes(`source_hash: ${sourceHash}`)) {
            return { updated: false, reason: 'unchanged' as const };
        }
    }

    const parsed = parseLegacyMemorySections(coreContent);
    const body = `# Profile

## User Preferences
${parsed.userPreferences || ''}

## Key Decisions
${parsed.keyDecisions || ''}

## Active Projects
${parsed.activeProjects || ''}
`;

    const existing = fs.existsSync(profilePath) ? safeReadFile(profilePath) : '';
    const existingCreatedAt = /^created_at:\s+(.+)$/m.exec(existing)?.[1]?.trim() || '';

    const fm = frontmatter({
        id: `profile-${instanceId()}`,
        home_id: instanceId(),
        kind: 'profile',
        source: 'legacy-memory-md',
        trust_level: 'high',
        source_hash: sourceHash,
        created_at: existingCreatedAt || new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });

    writeText(profilePath, fm + body);
    reindexSingleFile(root, profilePath);
    updateImportedCount('core', 1);

    return { updated: true, path: profilePath, sourceHash };
}

function importMarkdownMemory(root: string) {
    const legacyDir = join(JAW_HOME, 'memory');
    if (!fs.existsSync(legacyDir)) return 0;
    const files = listMarkdownFiles(legacyDir).filter(f => f !== join(legacyDir, 'MEMORY.md'));
    let imported = 0;
    for (const file of files) {
        const rel = relative(legacyDir, file).replace(/\\/g, '/');
        const body = safeReadFile(file);
        const sourceHash = hashText(body);
        const baseName = rel.split('/').pop() || 'memory.md';
        const isDated = /^\d{4}-\d{2}-\d{2}\.md$/.test(baseName);
        const sectionDir = isDated ? 'episodes/imported' : 'semantic/imported';
        const dest = join(root, sectionDir, rel);
        const fm = frontmatter({
            id: `import-${sourceHash}`,
            home_id: instanceId(),
            kind: isDated ? 'episode' : 'semantic',
            source: 'legacy-markdown',
            trust_level: 'high',
            source_relpath: rel,
            source_hash: sourceHash,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
        writeText(dest, fm + body.trim() + '\n');
        imported += 1;
    }
    return imported;
}

function importKvMemory(root: string) {
    const rows = getMemory.all() as Array<{ key: string; value: string; source?: string }>;
    if (!rows.length) return 0;
    const lines = rows.map(r => `- \`${r.key}\`: ${r.value} ${r.source ? `(source: ${r.source})` : ''}`);
    const fm = frontmatter({
        id: `kv-${instanceId()}`,
        home_id: instanceId(),
        kind: 'semantic',
        source: 'legacy-kv-table',
        trust_level: 'high',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });
    writeText(join(root, 'semantic', 'kv-imported.md'), fm + '# Imported KV Memory\n\n' + lines.join('\n') + '\n');
    return rows.length;
}

function importClaudeSessionMemory(root: string) {
    const claudeDir = getLegacyClaudeMemoryDir();
    if (!fs.existsSync(claudeDir)) return 0;
    const files = listMarkdownFiles(claudeDir);
    let imported = 0;
    for (const file of files) {
        const real = fs.realpathSync(file);
        const body = safeReadFile(file);
        const sourceHash = hashText(body);
        const base = slug(relative(claudeDir, real).replace(/\\/g, '/')) || slug(file.split('/').pop() || 'legacy');
        const dest = join(root, 'episodes', 'legacy', `${base}-${sourceHash}.md`);
        const fm = frontmatter({
            id: `claude-${sourceHash}`,
            home_id: instanceId(),
            kind: 'episode',
            source: 'external-claude-memory',
            trust_level: 'medium',
            source_realpath: real.replace(/\\/g, '/'),
            source_hash: sourceHash,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
        writeText(dest, fm + body.trim() + '\n');
        imported += 1;
    }
    return imported;
}

function backupLegacyMemory() {
    const backupRoot = join(JAW_HOME, 'backup-memory-v1');
    ensureDir(backupRoot);
    const legacyMemoryDir = join(JAW_HOME, 'memory');
    const backupMemoryDir = join(backupRoot, 'memory');
    if (fs.existsSync(legacyMemoryDir)) {
        fs.rmSync(backupMemoryDir, { recursive: true, force: true });
        fs.cpSync(legacyMemoryDir, backupMemoryDir, { recursive: true });
    }
    const kvRows = getMemory.all();
    writeText(join(backupRoot, 'memory-kv.json'), JSON.stringify(kvRows, null, 2));
    return backupRoot;
}

function importSingleMarkdownFile(root: string, file: string) {
    const legacyDir = join(JAW_HOME, 'memory');
    if (!file.startsWith(legacyDir)) return null;
    const rel = relative(legacyDir, file).replace(/\\/g, '/');
    if (!rel || rel === 'MEMORY.md') return null;
    const body = safeReadFile(file);
    const sourceHash = hashText(body);
    const baseName = rel.split('/').pop() || 'memory.md';
    const isDated = /^\d{4}-\d{2}-\d{2}\.md$/.test(baseName);
    const sectionDir = isDated ? 'episodes/imported' : 'semantic/imported';
    const dest = join(root, sectionDir, rel);
    const fm = frontmatter({
        id: `import-${sourceHash}`,
        home_id: instanceId(),
        kind: isDated ? 'episode' : 'semantic',
        source: 'legacy-markdown',
        trust_level: 'high',
        source_relpath: rel,
        source_hash: sourceHash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });
    writeText(dest, fm + body.trim() + '\n');
    reindexSingleFile(root, dest);
    return dest;
}

function isAdvancedShadowEnabled() {
    return fs.existsSync(getMetaPath());
}

function updateImportedCount(kind: keyof NonNullable<AdvancedMeta['importedCounts']>, value: number) {
    const meta = readMeta();
    writeMeta({
        importedCounts: {
            ...(meta?.importedCounts || DEFAULT_IMPORTED_COUNTS),
            [kind]: value,
        },
    });
}

export function syncLegacyMarkdownShadowImport(file: string) {
    if (!isAdvancedShadowEnabled()) return { ok: false, reason: 'advanced_not_ready' };
    const root = getAdvancedMemoryDir();
    if (file === join(JAW_HOME, 'memory', 'MEMORY.md')) {
        const count = importCoreMemory(root);
        updateImportedCount('core', count);
        if (count > 0) reindexSingleFile(root, join(root, 'profile.md'));
        return { ok: true, target: join(root, 'profile.md'), count };
    }
    const target = importSingleMarkdownFile(root, file);
    if (!target) return { ok: false, reason: 'not_importable' };
    updateImportedCount('markdown', countMarkdownFiles(join(root, 'semantic')) + countMarkdownFiles(join(root, 'episodes')));
    return { ok: true, target, count: 1 };
}

export function syncKvShadowImport() {
    if (!isAdvancedShadowEnabled()) return { ok: false, reason: 'advanced_not_ready' };
    const root = getAdvancedMemoryDir();
    const count = importKvMemory(root);
    updateImportedCount('kv', count);
    reindexSingleFile(root, join(root, 'semantic', 'kv-imported.md'));
    return { ok: true, target: join(root, 'semantic', 'kv-imported.md'), count };
}

export function ensureAdvancedMemoryStructure() {
    const root = getAdvancedMemoryDir();
    return withMigrationLock(() => {
        const sharedDir = join(root, 'shared');
        const episodesDir = join(root, 'episodes');
        const semanticDir = join(root, 'semantic');
        const proceduresDir = join(root, 'procedures');
        const sessionsDir = join(root, 'sessions');
        const corruptedDir = join(root, 'corrupted');
        const unmappedDir = join(root, 'legacy-unmapped');
        migrateLegacyAdvancedRoot(root);
        ensureDir(root);
        ensureDir(sharedDir);
        ensureDir(episodesDir);
        ensureDir(semanticDir);
        ensureDir(proceduresDir);
        ensureDir(sessionsDir);
        ensureDir(corruptedDir);
        ensureDir(unmappedDir);

        writeMeta({
            schemaVersion: 1,
            phase: '10',
            homeId: instanceId(),
            jawHome: JAW_HOME,
            initializedAt: readMeta()?.initializedAt || new Date().toISOString(),
            migrationVersion: 1,
            migrationState: 'done',
            migratedAt: readMeta()?.migratedAt || new Date().toISOString(),
            sourceLayout: fs.existsSync(getLegacyAdvancedMemoryDir()) ? 'advanced' : 'legacy',
        });

        const profilePath = join(root, 'profile.md');
        if (!fs.existsSync(profilePath)) {
            const fm = frontmatter({
                id: `profile-${instanceId()}`,
                home_id: instanceId(),
                kind: 'profile',
                source: 'generated',
                trust_level: 'high',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            writeText(profilePath, fm + `# Profile

## User Preferences

## Key Decisions

## Active Projects
`);
        }

        const soulPath = join(root, 'shared', 'soul.md');
        if (!fs.existsSync(soulPath)) {
            const sfm = frontmatter({
                id: `soul-${instanceId()}`,
                home_id: instanceId(),
                kind: 'shared',
                source: 'bootstrap',
                trust_level: 'high',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            writeText(soulPath, sfm + `# Soul

## Core Values
- Accuracy over speed — verify before claiming completion
- Respect user decisions — confirm before overriding

## Tone
- Friendly, warm
- Technically precise, concise

## Boundaries
- Never fabricate sources or citations
- Never execute destructive operations without explicit approval

## Relationship
- Collaborative partner, not a passive tool
- Proactive about risks, deferential about preferences

## Defaults
- When ambiguous, ask rather than guess
- Prefer existing patterns over novel approaches
`);
        }

        return { root, metaPath: getMetaPath(), profilePath };
    });
}

export function bootstrapAdvancedMemory(options: BootstrapOptions = {}) {
    const root = getAdvancedMemoryDir();
    ensureAdvancedMemoryStructure();
    writeMeta({
        phase: '10',
        bootstrapStatus: 'running',
        lastBootstrapAt: new Date().toISOString(),
        lastError: '',
    });

    const resolved = {
        importCore: options.importCore !== false,
        importMarkdown: options.importMarkdown !== false,
        importKv: options.importKv !== false,
        importClaudeSession: options.importClaudeSession !== false,
    };

    try {
        const backupRoot = backupLegacyMemory();
        const counts = {
            core: resolved.importCore ? importCoreMemory(root) : 0,
            markdown: resolved.importMarkdown ? importMarkdownMemory(root) : 0,
            kv: resolved.importKv ? importKvMemory(root) : 0,
            claude: resolved.importClaudeSession ? importClaudeSessionMemory(root) : 0,
        };
        const { totalFiles, totalChunks } = reindexAll(root);
        const meta = writeMeta({
            phase: '10',
            bootstrapStatus: 'done',
            importedCounts: counts,
            lastBootstrapAt: new Date().toISOString(),
            lastError: '',
        });
        return { root, backupRoot, counts, indexed: { totalFiles, totalChunks }, meta };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeMeta({
            phase: '10',
            bootstrapStatus: 'failed',
            lastBootstrapAt: new Date().toISOString(),
            lastError: message,
        });
        throw err;
    }
}

// ensureIntegratedMemoryReady is in runtime.ts (depends on getAdvancedMemoryStatus)
