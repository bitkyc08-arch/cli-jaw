import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { join, relative, dirname } from 'path';
import { createHash, createSign } from 'crypto';
import { JAW_HOME, settings } from '../core/config.js';
import { instanceId } from '../core/instance.js';
import { getMemory } from '../core/db.js';

type BootstrapOptions = {
    importCore?: boolean;
    importMarkdown?: boolean;
    importKv?: boolean;
    importClaudeSession?: boolean;
};

type AdvancedConfig = {
    enabled?: boolean;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    vertexConfig?: string;
    bootstrap?: {
        enabled?: boolean;
        useActiveCli?: boolean;
        cli?: string;
        model?: string;
    };
};

type AdvancedMeta = {
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

type SearchHit = {
    path: string;
    relpath: string;
    kind: string;
    source_start_line: number;
    source_end_line: number;
    snippet: string;
    score: number;
};

type ParsedMarkdown = {
    meta: Record<string, string>;
    body: string;
    bodyStartLine: number;
};

const DEFAULT_IMPORTED_COUNTS = { core: 0, markdown: 0, kv: 0, claude: 0 };
let lastExpansionTerms: string[] = [];

type VertexConfig = {
    endpoint?: string;
    token?: string;
    model?: string;
    project_id?: string;
    projectId?: string;
    location?: string;
    credentials_path?: string;
    credentialsPath?: string;
    credentials_json?: Record<string, any>;
    credentialsJson?: Record<string, any>;
};

function getLegacyAdvancedMemoryDir() {
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

function getAdvancedIndexDbPath() {
    return join(getAdvancedMemoryDir(), 'index.sqlite');
}

function getMigrationLockPath() {
    return join(getAdvancedMemoryDir(), '.migration.lock');
}

export function normalizeOpenAiCompatibleBaseUrl(raw: string) {
    const value = String(raw || '').trim();
    if (!value) return '';
    const trimmed = value.replace(/\/+$/, '');
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function getAdvancedConfig(override: Partial<AdvancedConfig> = {}) {
    return {
        enabled: true,
        provider: override.provider ?? 'integrated',
        model: override.model ?? '',
        apiKey: override.apiKey ?? '',
        baseUrl: normalizeOpenAiCompatibleBaseUrl(override.baseUrl ?? ''),
        vertexConfig: override.vertexConfig ?? '',
        bootstrap: {
            enabled: override.bootstrap?.enabled ?? true,
            useActiveCli: override.bootstrap?.useActiveCli ?? true,
            cli: override.bootstrap?.cli ?? '',
            model: override.bootstrap?.model ?? '',
        },
    };
}

function ensureDir(path: string) {
    fs.mkdirSync(path, { recursive: true });
}

function safeReadFile(path: string) {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

function writeText(path: string, content: string) {
    ensureDir(dirname(path));
    fs.writeFileSync(path, content);
}

function frontmatter(meta: Record<string, string>) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(meta)) {
        lines.push(`${k}: ${v}`);
    }
    lines.push('---', '');
    return lines.join('\n');
}

function hashText(text: string) {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function heuristicKeywords(query: string) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = q.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    const out = new Set<string>([q, ...tokens]);
    const lower = q.toLowerCase();
    if (/login|로그인|auth|인증/.test(lower)) {
        out.add('login');
        out.add('auth');
        out.add('인증');
        out.add('401');
    }
    if (/launchd|service|plist|시작 안됨/.test(lower)) {
        out.add('launchd');
        out.add('plist');
        out.add('service');
    }
    return [...out].slice(0, 5);
}

function sanitizeKeywords(input: unknown) {
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

function extractJsonArray(text: string) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return sanitizeKeywords(parsed);
    } catch {
        const match = trimmed.match(/\[[\s\S]*\]/);
        if (match) {
            try {
                return sanitizeKeywords(JSON.parse(match[0]));
            } catch {
                return [];
            }
        }
        return [];
    }
}

async function expandViaGemini(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfg = getAdvancedConfig(override);
    const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY || '';
    const model = cfg.model || 'gemini-3.1-flash-lite-preview';
    if (!apiKey) return [];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
        contents: [{
            parts: [{
                text: `사용자 질문을 바탕으로 로컬 마크다운 기억을 뒤질 검색 키워드 5개를 JSON 배열로만 출력해라.
- 한국어, 영어, 동의어, 에러코드, 모듈명 포함 가능
- 예: ["로그인","login","auth","401","인증"]

질문: ${query}`,
            }],
        }],
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('\n') || '';
    return extractJsonArray(text);
}

async function expandViaOpenAiCompatible(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfg = getAdvancedConfig(override);
    const apiKey = cfg.apiKey || '';
    const baseUrl = cfg.baseUrl || '';
    const model = cfg.model || 'gpt-4o-mini';
    if (!apiKey || !baseUrl) return [];
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'Return only valid JSON: {"keywords":["k1","k2","k3"]}',
                },
                {
                    role: 'user',
                    content: `Expand this user query into up to 5 search keywords for local markdown search. Include Korean, English, synonyms, error codes, module names when helpful.\nQuery: ${query}`,
                },
            ],
        }),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content || '';
    try {
        const parsed = JSON.parse(text);
        return sanitizeKeywords(parsed.keywords);
    } catch {
        return extractJsonArray(text);
    }
}

function loadServiceAccount(config: VertexConfig) {
    if (config.credentials_json || config.credentialsJson) return config.credentials_json || config.credentialsJson;
    const path = config.credentials_path || config.credentialsPath || '';
    if (!path) return null;
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

async function getGoogleAccessToken(sa: any) {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: sa.token_uri,
        exp,
        iat,
    })).toString('base64url');
    const unsigned = `${header}.${claim}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(sa.private_key).toString('base64url');
    const assertion = `${unsigned}.${signature}`;

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
    });
    const res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) return '';
    const json: any = await res.json();
    return json?.access_token || '';
}

async function expandViaVertex(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfgSetting = getAdvancedConfig(override);
    const cfgRaw = cfgSetting.vertexConfig || '';
    if (!cfgRaw) return [];
    let cfg: VertexConfig;
    try { cfg = JSON.parse(cfgRaw); } catch { return []; }

    let endpoint = cfg.endpoint || '';
    let token = cfg.token || '';
    const model = cfgSetting.model || cfg.model || 'gemini-3.1-flash-lite-preview';

    if (!endpoint) {
        const sa = loadServiceAccount(cfg);
        const project = cfg.project_id || cfg.projectId || sa?.project_id;
        const location = cfg.location || 'us-central1';
        if (sa && !token) token = await getGoogleAccessToken(sa);
        if (project) {
            endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
        }
    }
    if (!endpoint || !token) return [];

    const body = {
        contents: [{
            role: 'user',
            parts: [{
                text: `Return only a JSON array of up to 5 search keywords for local markdown search. Include Korean, English, synonyms, error codes, module names when useful.\nQuery: ${query}`,
            }],
        }],
    };
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('\n') || '';
    return extractJsonArray(text);
}

export async function expandSearchKeywords(query: string) {
    const q = String(query || '').trim();
    if (!q) return [];
    const merged = sanitizeKeywords(heuristicKeywords(q));
    lastExpansionTerms = merged;
    return merged;
}

export async function validateAdvancedMemoryConfig(override: Partial<AdvancedConfig> = {}) {
    const cfg = getAdvancedConfig(override);
    return { ok: true, provider: cfg.provider || 'integrated', error: '' };
}

function slug(value: string) {
    return value
        .replace(/\\/g, '/')
        .replace(/[^a-zA-Z0-9._/-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function listMarkdownFiles(dir: string) {
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

function countMarkdownFiles(dir: string) {
    return listMarkdownFiles(dir).length;
}

function countFiles(dir: string) {
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

function getMetaPath() {
    return join(getAdvancedMemoryDir(), 'meta.json');
}

function readMeta(): AdvancedMeta | null {
    const metaPath = getMetaPath();
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AdvancedMeta;
    } catch {
        return null;
    }
}

function writeMeta(patch: Partial<AdvancedMeta>) {
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

function withMigrationLock<T>(fn: () => T) {
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

function migrateLegacyAdvancedRoot(root: string) {
    const oldRoot = getLegacyAdvancedMemoryDir();
    if (!fs.existsSync(oldRoot) || oldRoot === root) return false;
    const newExists = fs.existsSync(root) && fs.readdirSync(root).length > 0;
    if (newExists) return false;
    ensureDir(dirname(root));
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
        // Profile already exists — preserve user edits, skip overwrite
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
    const backupRoot = getAdvancedMemoryBackupDir();
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

function parseMarkdownFile(raw: string): ParsedMarkdown {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') {
        return { meta: {}, body: raw, bodyStartLine: 1 };
    }
    const closing = lines.findIndex((line, idx) => idx > 0 && line === '---');
    if (closing === -1) {
        return { meta: {}, body: raw, bodyStartLine: 1 };
    }
    const meta: Record<string, string> = {};
    for (const line of lines.slice(1, closing)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) meta[key] = value;
    }
    return {
        meta,
        body: lines.slice(closing + 1).join('\n'),
        bodyStartLine: closing + 2,
    };
}

function buildHeaderPath(stack: string[]) {
    return stack.filter(Boolean).join(' > ');
}

function chunkMarkdown(absPath: string, relpath: string, kind: string) {
    const raw = safeReadFile(absPath);
    const parsed = parseMarkdownFile(raw);
    const lines = parsed.body.split('\n');
    const chunks: Array<{
        relpath: string;
        path: string;
        kind: string;
        source_start_line: number;
        source_end_line: number;
        source_hash: string;
        content: string;
    }> = [];

    const headings: string[] = [];
    let currentStart = parsed.bodyStartLine;
    let currentBody: string[] = [];
    let currentHeader = '';

    const flush = (endLine: number) => {
        const body = currentBody.join('\n').trim();
        if (!body) return;
        const headerPath = buildHeaderPath(headings);
        const prefix = [
            `Source: ${relpath}`,
            `Kind: ${kind}`,
            headerPath ? `Header: ${headerPath}` : '',
        ].filter(Boolean).join('\n');
        const content = `${prefix}\n\n${body}`.trim();
        chunks.push({
            relpath,
            path: absPath,
            kind,
            source_start_line: currentStart,
            source_end_line: endLine,
            source_hash: hashText(`${relpath}:${currentStart}:${body}`),
            content,
        });
    };

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx] ?? '';
        const actualLine = parsed.bodyStartLine + idx;
        const headerMatch = /^(#{1,3})\s+(.+)$/.exec(line.trim());
        if (headerMatch) {
            flush(actualLine - 1);
            const level = headerMatch[1]?.length || 1;
            headings[level - 1] = headerMatch[2]?.trim() || '';
            headings.length = level;
            currentHeader = headerMatch[2]?.trim() || '';
            currentStart = actualLine;
            currentBody = [line];
            continue;
        }
        if (!currentBody.length) {
            currentStart = actualLine;
            currentBody = currentHeader ? [currentHeader, line] : [line];
        } else {
            currentBody.push(line);
        }
    }
    flush(parsed.bodyStartLine + lines.length - 1);

    if (chunks.length === 0 && parsed.body.trim()) {
        chunks.push({
            relpath,
            path: absPath,
            kind,
            source_start_line: parsed.bodyStartLine,
            source_end_line: parsed.bodyStartLine + lines.length - 1,
            source_hash: hashText(`${relpath}:${parsed.body}`),
            content: parsed.body.trim(),
        });
    }
    return chunks;
}

function getIndexDb() {
    ensureDir(getAdvancedMemoryDir());
    const db = new Database(getAdvancedIndexDbPath());
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            relpath TEXT NOT NULL,
            kind TEXT NOT NULL,
            home_id TEXT NOT NULL DEFAULT '',
            source_start_line INTEGER NOT NULL,
            source_end_line INTEGER NOT NULL,
            source_hash TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_relpath ON chunks(relpath);
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            relpath UNINDEXED,
            kind UNINDEXED,
            tokenize = 'unicode61'
        );
    `);
    return db;
}

function clearIndex(db: any) {
    db.exec('DELETE FROM chunks;');
    db.exec(`DELETE FROM chunks_fts;`);
}

function indexedFiles(root: string) {
    const buckets = [
        join(root, 'profile.md'),
        ...listMarkdownFiles(join(root, 'shared')),
        ...listMarkdownFiles(join(root, 'episodes')),
        ...listMarkdownFiles(join(root, 'semantic')),
        ...listMarkdownFiles(join(root, 'procedures')),
    ];
    return buckets.filter((value, idx, arr) => value && arr.indexOf(value) === idx && fs.existsSync(value));
}

function kindForFile(root: string, file: string) {
    const rel = relative(root, file).replace(/\\/g, '/');
    if (rel === 'profile.md') return 'profile';
    if (rel.startsWith('shared/')) return 'shared';
    if (rel.startsWith('episodes/')) return 'episode';
    if (rel.startsWith('semantic/')) return 'semantic';
    if (rel.startsWith('procedures/')) return 'procedure';
    return 'memory';
}

function reindexAll(root: string) {
    const db = getIndexDb();
    clearIndex(db);

    const now = new Date().toISOString();
    const homeId = instanceId();
    const insertChunk = db.prepare(`
        INSERT INTO chunks (path, relpath, kind, home_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
        INSERT INTO chunks_fts (rowid, content, relpath, kind)
        VALUES (?, ?, ?, ?)
    `);

    let totalFiles = 0;
    let totalChunks = 0;
    const tx = db.transaction(() => {
        for (const file of indexedFiles(root)) {
            totalFiles += 1;
            const rel = relative(root, file).replace(/\\/g, '/');
            const kind = kindForFile(root, file);
            for (const chunk of chunkMarkdown(file, rel, kind)) {
                const contentHash = hashText(chunk.content);
                const info = insertChunk.run(
                    chunk.path,
                    chunk.relpath,
                    chunk.kind,
                    homeId,
                    chunk.source_start_line,
                    chunk.source_end_line,
                    chunk.source_hash,
                    chunk.content,
                    contentHash,
                    now,
                );
                insertFts.run(
                    Number(info.lastInsertRowid),
                    chunk.content,
                    chunk.relpath,
                    chunk.kind,
                );
                totalChunks += 1;
            }
        }
    });
    tx();
    db.close();
    return { totalFiles, totalChunks };
}

function reindexSingleFile(root: string, file: string) {
    if (!fs.existsSync(file)) return 0;
    const db = getIndexDb();
    const rel = relative(root, file).replace(/\\/g, '/');
    const kind = kindForFile(root, file);
    const now = new Date().toISOString();
    const homeId = instanceId();

    // Delete existing chunks for this file
    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE relpath = ?)').run(rel);
    db.prepare('DELETE FROM chunks WHERE relpath = ?').run(rel);

    // Re-chunk and insert
    const insertChunk = db.prepare(
        'INSERT INTO chunks (path, relpath, kind, home_id, source_start_line, source_end_line, source_hash, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertFts = db.prepare(
        'INSERT INTO chunks_fts (rowid, content, relpath, kind) VALUES (?, ?, ?, ?)'
    );
    let count = 0;
    const tx = db.transaction(() => {
        for (const chunk of chunkMarkdown(file, rel, kind)) {
            const contentHash = hashText(chunk.content);
            const info = insertChunk.run(chunk.path, chunk.relpath, chunk.kind, homeId, chunk.source_start_line, chunk.source_end_line, chunk.source_hash, chunk.content, contentHash, now);
            insertFts.run(Number(info.lastInsertRowid), chunk.content, chunk.relpath, chunk.kind);
            count++;
        }
    });
    tx();
    db.close();
    return count;
}

export function reindexIntegratedMemoryFile(file: string) {
    const root = getAdvancedMemoryDir();
    if (!fs.existsSync(file)) return 0;
    if (!file.startsWith(root)) return 0;
    return reindexSingleFile(root, file);
}

function buildLikeTerm(term: string) {
    return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

function tokenizeQuery(query: string) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return [];
    const tokens = trimmed
        .split(/[\s,]+/)
        .map(t => t.trim())
        .filter(Boolean);
    return Array.from(new Set([trimmed, ...tokens])).slice(0, 8);
}

function tokenizeExpandedQuery(query: string, expanded?: string[]) {
    if (expanded?.length) return sanitizeKeywords([query, ...expanded]).slice(0, 8);
    return tokenizeQuery(query);
}

function formatHits(hits: SearchHit[]) {
    if (!hits.length) return '(no results)';
    return hits.map(hit => {
        const loc = `${hit.relpath}:${hit.source_start_line}-${hit.source_end_line}`;
        return `${loc}\n${hit.snippet}`;
    }).join('\n\n---\n\n');
}

function searchIndex(query: string, expanded?: string[]) {
    const db = getIndexDb();
    const searchTerms = tokenizeExpandedQuery(query, expanded);
    if (!searchTerms.length) {
        db.close();
        return { hits: [] as SearchHit[] };
    }

    const byPathLine = new Map<string, SearchHit>();
    const ftsStmt = db.prepare(`
        SELECT
            c.path,
            c.relpath,
            c.kind,
            c.source_start_line,
            c.source_end_line,
            c.content,
            bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT 16
    `);
    const likeStmt = db.prepare(`
        SELECT path, relpath, kind, source_start_line, source_end_line, content
        FROM chunks
        WHERE content LIKE ? ESCAPE '\\'
        ORDER BY relpath ASC, source_start_line ASC
        LIMIT 16
    `);

    for (const term of searchTerms) {
        const ftsQuery = term.split(/\s+/).map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
        try {
            const rows = ftsStmt.all(ftsQuery) as any[];
            for (const row of rows) {
                const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
                if (!byPathLine.has(key)) {
                    byPathLine.set(key, {
                        path: row.path,
                        relpath: row.relpath,
                        kind: row.kind,
                        source_start_line: row.source_start_line,
                        source_end_line: row.source_end_line,
                        snippet: String(row.content || '').slice(0, 700),
                        score: Number(row.score || 0),
                    });
                }
            }
        } catch {
            // ignore FTS parse issues, fallback to LIKE below
        }
        const likeRows = likeStmt.all(buildLikeTerm(term)) as any[];
        for (const row of likeRows) {
            const key = `${row.relpath}:${row.source_start_line}:${row.source_end_line}`;
            if (!byPathLine.has(key)) {
                byPathLine.set(key, {
                    path: row.path,
                    relpath: row.relpath,
                    kind: row.kind,
                    source_start_line: row.source_start_line,
                    source_end_line: row.source_end_line,
                    snippet: String(row.content || '').slice(0, 700),
                    score: 999,
                });
            }
        }
    }
    db.close();
    const hits = [...byPathLine.values()]
        .sort((a, b) => a.score - b.score)
        .slice(0, 8);
    return { hits };
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

function isAdvancedShadowEnabled() {
    return fs.existsSync(getMetaPath());
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

export function ensureIntegratedMemoryReady() {
    const created = ensureAdvancedMemoryStructure();
    const status = getAdvancedMemoryStatus();
    if (status.indexState === 'ready') return { created, bootstrapped: false, status };
    const hasLegacy = fs.existsSync(join(JAW_HOME, 'memory', 'MEMORY.md'))
        || fs.existsSync(join(JAW_HOME, 'memory', 'daily'))
        || fs.existsSync(getLegacyClaudeMemoryDir())
        || (getMemory.all() as any[]).length > 0
        || fs.existsSync(getLegacyAdvancedMemoryDir());
    if (!hasLegacy) {
        const result = reindexAdvancedMemory();
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

export function reindexAdvancedMemory() {
    const root = getAdvancedMemoryDir();
    ensureAdvancedMemoryStructure();
    return reindexAll(root);
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
    const terms = Array.isArray(query as any)
        ? (query as any[]).map(v => String(v || '').trim()).filter(Boolean)
        : [String(query || '').trim()].filter(Boolean);
    const baseQuery = terms[0] || '';
    const expanded = terms.length > 1 ? terms.slice(1) : undefined;
    const { hits } = searchIndex(baseQuery, expanded);
    return formatHits(hits);
}

export function loadAdvancedProfileSummary(maxChars = 800) {
    const file = join(getAdvancedMemoryDir(), 'profile.md');
    if (!fs.existsSync(file)) return '';
    const parsed = parseMarkdownFile(safeReadFile(file));
    const body = parsed.body.trim();
    if (!body) return '';
    return body.length > maxChars ? body.slice(0, maxChars) + '\n...(truncated)' : body;
}

export function buildTaskSnapshot(query: string | string[], budget = 2800, expanded?: string[]) {
    const terms = Array.isArray(query)
        ? query.map(v => String(v || '').trim()).filter(Boolean)
        : [String(query || '').trim()].filter(Boolean);
    const cleaned = terms[0] || '';
    if (!cleaned) return '';
    const mergedExpanded = expanded?.length ? expanded : (terms.length > 1 ? terms.slice(1) : undefined);
    const { hits } = searchIndex(cleaned, mergedExpanded);
    if (!hits.length) return '';

    const out: string[] = [];
    let remaining = Math.max(0, budget);

    for (const hit of hits.slice(0, 4)) {
        if (remaining <= 0) break;
        const header = `### ${hit.relpath}:${hit.source_start_line}-${hit.source_end_line}`;
        const snippetBudget = Math.min(700, Math.max(0, remaining - header.length - 4));
        if (snippetBudget <= 0) break;
        const snippet = hit.snippet.slice(0, snippetBudget).trim();
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
        lastExpansion: lastExpansionTerms,
        lastError: meta?.lastError || '',
        importedCounts: meta?.importedCounts || { ...DEFAULT_IMPORTED_COUNTS },
        backupRoot: getAdvancedMemoryBackupDir(),
    };
}

function reindexIndexCounts(dbPath: string) {
    const db = new Database(dbPath, { readonly: true });
    const totalChunks = Number((db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as any)?.c || 0);
    const totalFiles = Number((db.prepare('SELECT COUNT(DISTINCT relpath) AS c FROM chunks').get() as any)?.c || 0);
    db.close();
    return { totalFiles, totalChunks };
}

export {
    getAdvancedMemoryDir as getStructuredMemoryDir,
    getAdvancedMemoryBackupDir as getMemoryBackupDir,
    getAdvancedFlushFilePath as getMemoryFlushFilePath,
    ensureAdvancedMemoryStructure as ensureMemoryStructure,
    bootstrapAdvancedMemory as bootstrapMemory,
    ensureIntegratedMemoryReady as ensureMemoryRuntimeReady,
    reindexAdvancedMemory as reindexMemory,
    listAdvancedMemoryFiles as listMemoryFiles,
    searchAdvancedMemory as searchIndexedMemory,
    readAdvancedMemorySnippet as readIndexedMemorySnippet,
    getAdvancedMemoryStatus as getMemoryStatus,
    loadAdvancedProfileSummary as loadProfileSummary,
};
