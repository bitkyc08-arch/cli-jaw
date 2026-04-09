import fs from 'fs';
import { join, relative, dirname } from 'path';
import { createHash } from 'crypto';
import { JAW_HOME } from '../core/config.js';
import { instanceId } from '../core/instance.js';

export type BootstrapOptions = {
    importCore?: boolean;
    importMarkdown?: boolean;
    importKv?: boolean;
    importClaudeSession?: boolean;
};

export type AdvancedMeta = {
    schemaVersion: number;
    phase: string;
    homeId: string;
    jawHome: string;
    initializedAt: string;
    migrationVersion?: number;
    migrationState?: 'pending' | 'running' | 'done' | 'failed';
    migratedAt?: string | null;
    sourceLayout?: 'legacy' | 'advanced' | 'structured';
    bootstrapStatus?: 'idle' | 'running' | 'done' | 'failed';
    lastBootstrapAt?: string | null;
    lastError?: string;
    importedCounts?: {
        core: number;
        markdown: number;
        kv: number;
        claude: number;
    };
};

export type SearchHit = {
    path: string;
    relpath: string;
    kind: string;
    source_start_line: number;
    source_end_line: number;
    snippet: string;
    score: number;
};

export type ParsedMarkdown = {
    meta: Record<string, string>;
    body: string;
    bodyStartLine: number;
};

export const DEFAULT_IMPORTED_COUNTS = { core: 0, markdown: 0, kv: 0, claude: 0 };

export function getLegacyAdvancedMemoryDir() {
    return join(JAW_HOME, 'memory-advanced');
}

export function getAdvancedMemoryDir() {
    return join(JAW_HOME, 'memory', 'structured');
}

export function getAdvancedMemoryBackupDir() {
    return join(JAW_HOME, 'backup-memory-v1');
}

export function getAdvancedFlushFilePath(date = new Date().toISOString().slice(0, 10)) {
    return join(getAdvancedMemoryDir(), 'episodes', 'live', `${date}.md`);
}

export function getAdvancedIndexDbPath() {
    return join(getAdvancedMemoryDir(), 'index.sqlite');
}

export function getMigrationLockPath() {
    return join(getAdvancedMemoryDir(), '.migration.lock');
}

export function ensureDir(path: string) {
    fs.mkdirSync(path, { recursive: true });
}

export function safeReadFile(path: string) {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

export function writeText(path: string, content: string) {
    ensureDir(dirname(path));
    fs.writeFileSync(path, content);
}

export function frontmatter(meta: Record<string, string>) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(meta)) {
        lines.push(`${k}: ${v}`);
    }
    lines.push('---', '');
    return lines.join('\n');
}

export function hashText(text: string) {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function sanitizeKeywords(input: unknown) {
    const raw = Array.isArray(input) ? input : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const value = String(item || '')
            .replace(/[;&|`$><]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 48);
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= 5) break;
    }
    return out;
}

export function listMarkdownFiles(dir: string) {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.md')) out.push(full);
        }
    };
    walk(dir);
    return out.sort();
}

export function countMarkdownFiles(dir: string) {
    return listMarkdownFiles(dir).length;
}

export function countFiles(dir: string) {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else count++;
        }
    };
    walk(dir);
    return count;
}

export function getMetaPath() {
    return join(getAdvancedMemoryDir(), 'meta.json');
}

export function readMeta(): AdvancedMeta | null {
    const metaPath = getMetaPath();
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AdvancedMeta;
    } catch {
        return null;
    }
}

export function writeMeta(patch: Partial<AdvancedMeta>) {
    const base: AdvancedMeta = readMeta() || {
        schemaVersion: 1,
        phase: '1',
        homeId: instanceId(),
        jawHome: JAW_HOME,
        initializedAt: new Date().toISOString(),
        migrationVersion: 1,
        migrationState: 'pending',
        migratedAt: null,
        sourceLayout: 'legacy',
        bootstrapStatus: 'idle',
        importedCounts: { ...DEFAULT_IMPORTED_COUNTS },
    };
    const next: AdvancedMeta = {
        ...base,
        ...patch,
        importedCounts: {
            ...(base.importedCounts || DEFAULT_IMPORTED_COUNTS),
            ...(patch.importedCounts || {}),
        },
    };
    writeText(getMetaPath(), JSON.stringify(next, null, 2));
    return next;
}

export function withMigrationLock<T>(fn: () => T) {
    const lockPath = getMigrationLockPath();
    ensureDir(dirname(lockPath));
    if (fs.existsSync(lockPath)) return fn();
    fs.writeFileSync(lockPath, String(process.pid));
    try {
        return fn();
    } finally {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
}
