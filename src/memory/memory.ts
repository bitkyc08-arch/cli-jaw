/**
 * src/memory.js — Phase A: grep-based persistent memory
 */
import { JAW_HOME } from '../core/config.js';
import { join, resolve, relative } from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';

export const MEMORY_DIR = join(JAW_HOME, 'memory');

const DEFAULT_MEMORY = `# Memory

## User Preferences


## Key Decisions


## Active Projects

`;

// ─── Init ────────────────────────────────────────

export function ensureMemoryDir() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const memPath = join(MEMORY_DIR, 'MEMORY.md');
    if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, DEFAULT_MEMORY);
    }
    return MEMORY_DIR;
}

function resolveMemoryPath(filename: string) {
    if (/\0/.test(filename)) throw new Error('memory_path_invalid_null_byte');
    const filepath = resolve(MEMORY_DIR, filename);
    const rel = relative(MEMORY_DIR, filepath).replace(/\\/g, '/');
    if (rel.startsWith('../') || rel === '..') {
        throw new Error('memory_path_out_of_root');
    }
    return filepath;
}

// ─── Search (grep) ───────────────────────────────

export function search(query: string) {
    ensureMemoryDir();
    if (!query || !query.trim()) return '(query required)';
    try {
        const proc = spawnSync(
            'grep',
            ['-rni', '--include=*.md', '-C', '3', '--', query, MEMORY_DIR],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }
        );
        if (proc.error) throw proc.error;
        if (proc.status === 1) return '(no results)';
        if (proc.status !== 0) {
            const msg = (proc.stderr || '').trim() || `grep exited with code ${proc.status}`;
            return `(search error: ${msg})`;
        }
        // Trim paths to relative
        return (proc.stdout || '').split(MEMORY_DIR + '/').join('');
    } catch (e) {
        console.warn('[memory:search] grep failed', { error: (e as Error).message });
        return '(no results)';
    }
}

// ─── Read ────────────────────────────────────────

export function read(filename: string, opts: Record<string, any> = {}) {
    const filepath = resolveMemoryPath(filename);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf8');
    if (opts.lines) {
        const [from, to] = opts.lines.split('-').map(Number);
        return content.split('\n').slice(from - 1, to).join('\n');
    }
    return content;
}

// ─── Save (append) ───────────────────────────────

export function save(filename: string, content: string) {
    ensureMemoryDir();
    const filepath = resolveMemoryPath(filename);
    fs.mkdirSync(join(filepath, '..'), { recursive: true });
    // Unescape \n from CLI
    const unescaped = content.replace(/\\n/g, '\n');
    fs.appendFileSync(filepath, '\n' + unescaped + '\n');
    void import('./runtime.js').then(m => {
        const normalized = filename.replace(/\\/g, '/');
        if (normalized.startsWith('structured/')) {
            m.reindexIntegratedMemoryFile(filepath);
            return;
        }
        if (normalized === 'MEMORY.md') {
            m.syncIntegratedCoreMemory();
            return;
        }
        m.syncLegacyMarkdownShadowImport(filepath);
    }).catch(err => {
        console.warn('[jaw:memory-save-sync]', (err as Error).message);
    });
    return filepath;
}

// ─── List ────────────────────────────────────────

export function list() {
    ensureMemoryDir();
    const files: Array<{ path: string; size: number; modified: string }> = [];
    function walk(dir: string, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) walk(join(dir, entry.name), prefix + entry.name + '/');
            else if (entry.name.endsWith('.md')) {
                const stat = fs.statSync(join(dir, entry.name));
                files.push({
                    path: prefix + entry.name,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                });
            }
        }
    }
    walk(MEMORY_DIR);
    return files;
}

// ─── Daily auto-log ──────────────────────────────

export function appendDaily(content: string) {
    ensureMemoryDir();
    const date = new Date().toISOString().slice(0, 10);
    const filepath = join(MEMORY_DIR, 'structured', 'episodes', 'daily', `${date}.md`);
    fs.mkdirSync(join(filepath, '..'), { recursive: true });
    const timestamp = new Date().toTimeString().slice(0, 5);
    fs.appendFileSync(filepath, `\n---\n**${timestamp}** ${content}\n`);
    void import('./runtime.js').then(m => m.reindexIntegratedMemoryFile(filepath)).catch(() => { });
    return filepath;
}

// ─── Load for prompt injection ───────────────────

export function loadMemoryForPrompt(maxChars = 1500) {
    const memPath = join(MEMORY_DIR, 'MEMORY.md');
    if (!fs.existsSync(memPath)) return '';
    const content = fs.readFileSync(memPath, 'utf8').trim();
    if (!content || content === DEFAULT_MEMORY.trim()) return '';
    return content.length > maxChars
        ? content.slice(0, maxChars) + '\n...(use `cli-jaw memory read MEMORY.md` for full content)'
        : content;
}
