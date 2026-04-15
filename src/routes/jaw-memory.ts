import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { assertMemoryRelPath } from '../security/path-guards.js';
import * as memory from '../memory/memory.js';
import { getMemoryStatus, searchIndexedMemory, readIndexedMemorySnippet, reflectMemory, hasSoulFile, loadSoulSummary, getAdvancedMemoryDir } from '../memory/runtime.js';
import { ensureAdvancedMemoryStructure } from '../memory/bootstrap.js';
import { reindexSingleFile } from '../memory/indexing.js';
import { join } from 'path';

function normalizeAdvancedReadPath(file: string): string {
    const value = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return value.startsWith('structured/') ? value.slice('structured/'.length) : value;
}

export function registerJawMemoryRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/jaw-memory/search', (req, res) => {
        try {
            const q = String(req.query.q || '');
            const mem = getMemoryStatus();
            res.json({ result: mem.routing.searchRead === 'advanced' ? searchIndexedMemory(q) : memory.search(q) });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/read', (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.query.file || ''), { allowExt: ['.md', '.txt', '.json'] });
            const mem = getMemoryStatus();
            const content = mem.routing.searchRead === 'advanced'
                ? readIndexedMemorySnippet(normalizeAdvancedReadPath(file), { lines: req.query.lines as any })
                : memory.read(file, { lines: req.query.lines as any });
            res.json({ content });
        } catch (e: unknown) { res.status((e as any).statusCode || 500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/save', requireAuth, (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.body.file || ''), { allowExt: ['.md', '.txt', '.json'] });
            const p = memory.save(file, req.body.content);
            res.json({ ok: true, path: p });
        } catch (e: unknown) { res.status((e as any).statusCode || 500).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/list', (_, res) => {
        try { res.json({ files: memory.list() }); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/init', requireAuth, (_, res) => {
        try { memory.ensureMemoryDir(); res.json({ ok: true }); }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/reflect', requireAuth, (req, res) => {
        try {
            const result = reflectMemory(req.body || {});
            res.json({ ok: true, result, status: getMemoryStatus() });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/jaw-memory/flush', requireAuth, async (req, res) => {
        try {
            const { triggerMemoryFlush } = await import('../agent/memory-flush-controller.js');
            await triggerMemoryFlush();
            res.json({ ok: true, message: 'Memory flush triggered' });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.get('/api/jaw-memory/soul', async (_req, res) => {
        try {
            const { readSoul } = await import('../memory/identity.js');
            res.json({ soul: readSoul() });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/soul/activate', requireAuth, async (_req, res) => {
        try {
            const hadSoul = hasSoulFile();
            ensureAdvancedMemoryStructure();
            const nowHasSoul = hasSoulFile();
            const created = !hadSoul && nowHasSoul;
            if (created) {
                const root = getAdvancedMemoryDir();
                reindexSingleFile(root, join(root, 'shared', 'soul.md'));
            }
            const soul = loadSoulSummary(2000);
            res.json({
                activated: true,
                created,
                preview: soul.slice(0, 200),
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/soul', requireAuth, async (req, res) => {
        try {
            const { applySoulUpdate } = await import('../memory/identity.js');
            const result = applySoulUpdate(req.body);
            res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });
}
