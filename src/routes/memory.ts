import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import fs from 'fs';
import { join } from 'path';
import { ok, fail } from '../http/response.js';
import { getMemory, upsertMemory, deleteMemory } from '../core/db.js';
import { settings, saveSettings, JAW_HOME } from '../core/config.js';
import * as memoryModule from '../memory/memory.js';
import { bootstrapMemory, getMemoryStatus, getLastReflectedAt, hasSoulFile, loadSoulSummary, listMemoryFiles, reindexMemory, syncKvShadowImport } from '../memory/runtime.js';
import { getFlushStatus } from '../agent/memory-flush-controller.js';
import { getMigrationLockPath, hashText, safeReadFile, readMeta } from '../memory/shared.js';
import { activeProcesses, memoryFlushCounter } from '../agent/spawn.js';
import { getMemoryDir } from '../prompt/builder.js';
import { assertMemoryRelPath, assertFilename, safeResolveUnder } from '../security/path-guards.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';

export function registerMemoryRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/memory/status', (_req, res) => {
        const base = getMemoryStatus();
        const lockPath = getMigrationLockPath();
        const migrationLocked = fs.existsSync(lockPath);
        const flushRunning = activeProcesses.has('memory-flush');
        const lastReflectedAt = getLastReflectedAt();

        let profileFresh = true;
        let profileSourceHash = '';
        let coreSourceHash = '';
        const staleWarnings: string[] = [];
        try {
            const corePath = join(JAW_HOME, 'memory', 'MEMORY.md');
            if (fs.existsSync(corePath)) {
                coreSourceHash = hashText(safeReadFile(corePath));
                const profilePath = join(base.storageRoot, 'profile.md');
                if (fs.existsSync(profilePath)) {
                    const profileContent = safeReadFile(profilePath);
                    const match = /^source_hash:\s+(\S+)$/m.exec(profileContent);
                    profileSourceHash = match?.[1] || '';
                    profileFresh = profileSourceHash === coreSourceHash;
                } else {
                    profileFresh = false;
                }
            }
        } catch { /* ignore */ }

        if (!profileFresh) staleWarnings.push('profile out of sync with MEMORY.md');
        if (migrationLocked) staleWarnings.push('migration lock held');
        if (flushRunning) staleWarnings.push('memory flush in progress');

        res.json({
            ...base,
            profileFresh,
            profileSourceHash,
            coreSourceHash,
            lastReflectedAt,
            flushRunning,
            migrationLocked,
            staleWarnings,
            hasSoul: hasSoulFile(),
            soulSynthesized: readMeta()?.soulSynthesized || false,
            soulPreview: hasSoulFile() ? loadSoulSummary(200) : '',
            flushStatus: getFlushStatus(),
        });
    });

    app.post('/api/memory/reindex', requireAuth, (_req, res) => {
        const result = reindexMemory();
        res.json({
            ok: true,
            message: 'Memory reindex completed.',
            result,
            status: getMemoryStatus(),
        });
    });

    app.post('/api/memory/bootstrap', requireAuth, (req, res) => {
        const result = bootstrapMemory(req.body || {});
        res.json({
            ok: true,
            message: 'Memory bootstrap completed.',
            result,
            status: getMemoryStatus(),
        });
    });

    app.get('/api/memory/files', (_req, res) => {
        res.json(listMemoryFiles());
    });

    // Key-value memory
    app.get('/api/memory', (_, res) => ok(res, getMemory.all()));
    app.post('/api/memory', requireAuth, (req, res) => {
        const { key, value, source = 'manual' } = req.body;
        if (!key || !value) return fail(res, 400, 'key and value required');
        upsertMemory.run(key, value, source);
        try { syncKvShadowImport(); } catch { /* best-effort */ }
        ok(res, null);
    });
    app.delete('/api/memory/:key', requireAuth, (req, res) => {
        deleteMemory.run(req.params.key);
        try { syncKvShadowImport(); } catch { /* best-effort */ }
        ok(res, null);
    });

    // Memory files (Claude native)
    app.get('/api/memory-files', (_, res) => {
        const memDir = getMemoryDir();
        const files = memoryModule.list()
            .sort((a, b) => b.path.localeCompare(a.path))
            .map(f => {
                const fullPath = safeResolveUnder(memDir, f.path);
                const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
                const entries = content.split(/^## /m).filter(Boolean).length;
                return { name: f.path, entries, size: f.size };
            });
        res.json({
            enabled: settings.memory?.enabled !== false,
            flushEvery: settings.memory?.flushEvery ?? 10,
            cli: settings.memory?.cli || '',
            model: settings.memory?.model || '',
            retentionDays: settings.memory?.retentionDays ?? 30,
            flushLanguage: settings.memory?.flushLanguage || 'en',
            path: memDir, files,
            counter: memoryFlushCounter,
        });
    });

    app.get('/api/memory-file', (req, res) => {
        try {
            const name = assertMemoryRelPath(String(req.query.path || ''), { allowExt: ['.md', '.txt', '.json'] });
            const fp = safeResolveUnder(getMemoryDir(), name);
            if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
            res.json({ name, content: fs.readFileSync(fp, 'utf8') });
        } catch (e: unknown) {
            res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
        }
    });

    app.get('/api/memory-files/:filename', (req, res) => {
        try {
            const name = assertFilename(req.params.filename);
            const fp = safeResolveUnder(getMemoryDir(), name);
            if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
            res.json({ name, content: fs.readFileSync(fp, 'utf8') });
        } catch (e: unknown) {
            res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
        }
    });

    app.delete('/api/memory-file', requireAuth, (req, res) => {
        try {
            const name = assertMemoryRelPath(String(req.query.path || ''), { allowExt: ['.md', '.txt', '.json'] });
            const fp = safeResolveUnder(getMemoryDir(), name);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            res.json({ ok: true });
        } catch (e: unknown) {
            res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
        }
    });

    app.delete('/api/memory-files/:filename', requireAuth, (req, res) => {
        try {
            const name = assertFilename(String(req.params.filename));
            const fp = safeResolveUnder(getMemoryDir(), name);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            res.json({ ok: true });
        } catch (e: unknown) {
            res.status((e as any).statusCode || 400).json({ error: (e as Error).message });
        }
    });

    app.put('/api/memory-files/settings', requireAuth, (req, res) => {
        const patch = { ...(req.body || {}) };
        const targetCli = typeof patch.cli === 'string' && patch.cli
            ? patch.cli
            : settings.memory?.cli || settings.cli || '';
        if (targetCli === 'claude' && typeof patch.model === 'string') {
            patch.model = migrateLegacyClaudeValue(patch.model);
        }
        settings.memory = { ...settings.memory, ...patch };
        saveSettings(settings);
        res.json({ ok: true });
    });
}
