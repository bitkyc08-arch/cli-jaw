import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { httpStatus, httpCode } from './_http-error.js';
import { assertMemoryRelPath } from '../security/path-guards.js';
import * as memory from '../memory/memory.js';
import { getMemoryStatus, searchIndexedMemory, readIndexedMemorySnippet, reflectMemory, hasSoulFile, loadSoulSummary, getAdvancedMemoryDir, safeReadFile, readMeta, writeMeta, listMemoryFiles, writeText } from '../memory/runtime.js';
import { ensureAdvancedMemoryStructure, scanSystemProfile } from '../memory/bootstrap.js';
import { reindexSingleFile } from '../memory/indexing.js';
import { getMemory } from '../core/db.js';
import { settings, getServerUrl, JAW_HOME } from '../core/config.js';
import { broadcast } from '../core/bus.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { buildSoulBootstrapPrompt } from '../prompt/soul-bootstrap-prompt.js';
import { join } from 'path';

function normalizeAdvancedReadPath(file: string): string {
    const value = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return value.startsWith('structured/') ? value.slice('structured/'.length) : value;
}

function countAdvancedMemoryFiles(): number {
    const sections = listMemoryFiles().sections;
    return Object.values(sections).reduce((sum, files) => sum + files.length, 0);
}

function flattenAdvancedMemoryFiles(): string[] {
    const sections = listMemoryFiles().sections;
    return [
        ...sections.profile,
        ...sections.shared,
        ...sections.episodes,
        ...sections.semantic,
        ...sections.procedures,
        ...sections.sessions,
    ];
}

export function buildMemorySyncPayload(reason: string) {
    return {
        reason,
        status: {
            ...getMemoryStatus(),
            hasSoul: hasSoulFile(),
            soulSynthesized: readMeta()?.soulSynthesized || false,
            soulPreview: hasSoulFile() ? loadSoulSummary(200) : '',
            legacyFileCount: memory.list().length,
            advancedFileCount: countAdvancedMemoryFiles(),
        },
    };
}

function broadcastMemorySync(reason: string): void {
    broadcast('memory_status', buildMemorySyncPayload(reason));
}

function saveCanonicalSoul(content: string): string {
    const root = getAdvancedMemoryDir();
    const soulPath = join(root, 'shared', 'soul.md');
    // Soul bootstrap provides a full document, so this path must overwrite.
    writeText(soulPath, String(content || ''));
    reindexSingleFile(root, soulPath);
    return soulPath;
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
                ? readIndexedMemorySnippet(normalizeAdvancedReadPath(file), { lines: req.query.lines as string | undefined })
                : memory.read(file, { lines: req.query.lines as string | undefined });
            res.json({ content });
        } catch (e: unknown) { res.status(httpStatus(e, 500)).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/save', requireAuth, (req, res) => {
        try {
            const file = assertMemoryRelPath(String(req.body.file || ''), { allowExt: ['.md', '.txt', '.json'] });
            const normalizedFile = file.replace(/\\/g, '/');
            const p = normalizedFile === 'shared/soul.md' || normalizedFile === 'structured/shared/soul.md'
                ? saveCanonicalSoul(req.body.content)
                : memory.save(file, req.body.content);
            const payload = buildMemorySyncPayload('save');
            broadcastMemorySync('save');
            res.json({ ok: true, path: p, ...payload });
        } catch (e: unknown) { res.status(httpStatus(e, 500)).json({ error: (e as Error).message }); }
    });

    app.get('/api/jaw-memory/list', (_, res) => {
        try {
            const mem = getMemoryStatus();
            const files = mem.routing.searchRead === 'advanced'
                ? flattenAdvancedMemoryFiles().map(path => ({ path, size: 0, modified: '' }))
                : memory.list();
            res.json({
                files,
                count: files.length,
                mode: mem.routing.searchRead,
                advancedFileCount: countAdvancedMemoryFiles(),
            });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/init', requireAuth, (_, res) => {
        try {
            memory.ensureMemoryDir();
            const payload = buildMemorySyncPayload('init');
            broadcastMemorySync('init');
            res.json({ ok: true, ...payload });
        }
        catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/reflect', requireAuth, (req, res) => {
        try {
            const result = reflectMemory(req.body || {});
            const payload = buildMemorySyncPayload('reflect');
            broadcastMemorySync('reflect');
            res.json({ ok: true, result, ...payload });
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
            const payload = buildMemorySyncPayload('soul_activate');
            broadcastMemorySync('soul_activate');
            res.json({
                activated: true,
                created,
                preview: soul.slice(0, 200),
                ...payload,
            });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/jaw-memory/soul', requireAuth, async (req, res) => {
        try {
            const { applySoulUpdate } = await import('../memory/identity.js');
            const result = applySoulUpdate(req.body);
            // Mark soul as synthesized when called with reason: 'soul-bootstrap'
            if (result.applied && req.body?.reason === 'soul-bootstrap') {
                writeMeta({
                    soulSynthesized: true,
                    soulSynthesizedAt: new Date().toISOString(),
                    soulSynthesizedCli: settings.cli || 'unknown',
                });
            }
            if (!result.applied && req.body?.reason === 'soul-bootstrap' && hasSoulFile()) {
                writeMeta({
                    soulSynthesized: true,
                    soulSynthesizedAt: new Date().toISOString(),
                    soulSynthesizedCli: settings.cli || 'unknown',
                });
            }
            const payload = buildMemorySyncPayload(req.body?.reason === 'soul-bootstrap' ? 'soul_bootstrap' : 'soul_update');
            if (result.applied || req.body?.reason === 'soul-bootstrap') {
                broadcastMemorySync(req.body?.reason === 'soul-bootstrap' ? 'soul_bootstrap' : 'soul_update');
            }
            res.json({ ...result, ...payload });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/soul/bootstrap', requireAuth, (req, res) => {
        try {
            const meta = readMeta();
            if (meta?.soulSynthesized) {
                return res.json({ ok: false, reason: 'already_synthesized' });
            }

            const root = getAdvancedMemoryDir();
            const systemProfile = scanSystemProfile();
            const currentSoul = safeReadFile(join(root, 'shared', 'soul.md'));
            const profileContent = safeReadFile(join(root, 'profile.md'));
            const kvEntries = (getMemory.all() as { key: string; value: string }[]) || [];
            const lang = settings.locale || req.body?.lang || 'en';

            const prompt = buildSoulBootstrapPrompt({
                systemProfile,
                currentSoul,
                profileContent,
                kvEntries,
                lang,
                serverUrl: getServerUrl(),
                instanceHome: JAW_HOME,
            });

            const result = submitMessage(prompt, {
                origin: 'system',
                displayText: lang === 'ko' ? '🧠 Soul 최적화 중...' : '🧠 Optimizing soul...',
            });

            if (result.action === 'rejected') {
                return res.json({ ok: false, reason: result.reason || 'no_active_agent' });
            }

            res.json({ ok: true, action: result.action, requestId: result.requestId });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });
}
