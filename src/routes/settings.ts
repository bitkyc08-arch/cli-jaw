import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import fs from 'fs';
import { join } from 'path';
import { ok } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';
import { settings, saveSettings, JAW_HOME, detectAllCli } from '../core/config.js';
import { readCodexContextWindow } from '../core/codex-config.js';
import { regenerateB, A2_PATH, HEARTBEAT_PATH } from '../prompt/builder.js';
import { clearTemplateCache, getTemplateDir } from '../prompt/template-loader.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { CLI_REGISTRY } from '../cli/registry.js';
import { readClaudeCreds, readCodexTokens, fetchClaudeUsage, fetchCodexUsage, readGeminiAccount, fetchGeminiUsage } from './quota.js';
import { fetchCopilotQuota, refreshCopilotFromKeychain } from '../../lib/quota-copilot.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';

export function registerSettingsRoutes(
    app: Express,
    requireAuth: AuthMiddleware,
    applySettings: (patch: Record<string, any>) => Promise<any>,
    projectRoot: string,
): void {
    app.get('/api/settings', (_, res) => {
        const safe = { ...settings };
        if (safe.stt) {
            const gKey = safe.stt.geminiApiKey || process.env.GEMINI_API_KEY || '';
            const oKey = safe.stt.openaiApiKey || '';
            safe.stt = { ...safe.stt, geminiApiKey: undefined, geminiKeySet: !!gKey, geminiKeyLast4: gKey.slice(-4) || '', openaiApiKey: undefined, openaiKeySet: !!oKey, openaiKeyLast4: oKey.slice(-4) || '' };
        }
        ok(res, safe, safe);
    });

    app.put('/api/settings', requireAuth, asyncHandler(async (req, res) => {
        const result = await applySettings(req.body);
        const safe = { ...result };
        if (safe.stt) {
            const gKey2 = safe.stt.geminiApiKey || process.env.GEMINI_API_KEY || '';
            const oKey2 = safe.stt.openaiApiKey || '';
            safe.stt = { ...safe.stt, geminiApiKey: undefined, geminiKeySet: !!gKey2, geminiKeyLast4: gKey2.slice(-4) || '', openaiApiKey: undefined, openaiKeySet: !!oKey2, openaiKeyLast4: oKey2.slice(-4) || '' };
        }
        ok(res, safe);
    }));

    app.get('/api/codex-context', (_, res) => {
        res.json(readCodexContextWindow());
    });

    app.get('/api/prompt', (_, res) => {
        const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
        res.json({ content: a2 });
    });

    app.put('/api/prompt', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null) return res.status(400).json({ error: 'content required' });
        fs.writeFileSync(A2_PATH, content);
        regenerateB();
        res.json({ ok: true });
    });

    app.get('/api/prompt-templates', (_, res) => {
        const dir = getTemplateDir();
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'));
        const templates = files.map((f: string) => ({
            id: f.replace('.md', ''),
            filename: f,
            content: fs.readFileSync(join(dir, f), 'utf8'),
        }));
        const tree = [
            {
                id: 'system', label: 'getSystemPrompt()', emoji: '🟢',
                children: ['a1-system', 'a2-default', 'orchestration', 'skills', 'heartbeat-jobs', 'heartbeat-default', 'vision-click']
            },
            {
                id: 'employee', label: 'getEmployeePrompt()', emoji: '🟡',
                children: ['employee', 'worker-context']
            },
        ];
        res.json({ templates, tree });
    });

    app.put('/api/prompt-templates/:id', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
        const filename = req.params.id + '.md';
        if (!/^[a-z0-9-]+\.md$/.test(filename)) return res.status(400).json({ error: 'invalid id' });
        const dir = getTemplateDir();
        fs.writeFileSync(join(dir, filename), content);
        const srcDir = join(projectRoot, 'src/prompt/templates');
        if (fs.existsSync(srcDir)) fs.writeFileSync(join(srcDir, filename), content);
        clearTemplateCache();
        regenerateB();
        res.json({ ok: true });
    });

    app.get('/api/heartbeat-md', (_, res) => {
        const content = fs.existsSync(HEARTBEAT_PATH) ? fs.readFileSync(HEARTBEAT_PATH, 'utf8') : '';
        res.json({ content });
    });

    app.put('/api/heartbeat-md', requireAuth, (req, res) => {
        const { content } = req.body;
        if (content == null) return res.status(400).json({ error: 'content required' });
        fs.writeFileSync(HEARTBEAT_PATH, content);
        res.json({ ok: true });
    });

    app.get('/api/mcp', (req, res) => res.json(loadUnifiedMcp()));

    app.put('/api/mcp', requireAuth, (req, res) => {
        const config = req.body;
        if (!config || !config.servers) return res.status(400).json({ error: 'servers object required' });
        saveUnifiedMcp(config);
        res.json({ ok: true, servers: Object.keys(config.servers) });
    });

    app.post('/api/mcp/sync', requireAuth, (req, res) => {
        const config = loadUnifiedMcp();
        const results = syncToAll(config);
        res.json({ ok: true, results });
    });

    app.post('/api/mcp/install', requireAuth, async (req, res) => {
        try {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('../../lib/mcp-sync.js');
            const results = await installMcpServers(config);
            saveUnifiedMcp(config);
            const syncResults = syncToAll(config);
            res.json({ ok: true, results, synced: syncResults });
        } catch (e: unknown) {
            console.error('[mcp:install]', e);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/mcp/reset', requireAuth, (req, res) => {
        try {
            const mcpPath = join(JAW_HOME, 'mcp.json');
            if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
            const config = initMcpConfig(settings.workingDir);
            const results = syncToAll(config);
            res.json({
                ok: true,
                servers: Object.keys(config.servers),
                count: Object.keys(config.servers).length,
                synced: results,
            });
        } catch (e: unknown) {
            console.error('[mcp:reset]', e);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    app.get('/api/cli-registry', (_, res) => res.json(CLI_REGISTRY));
    app.get('/api/cli-status', (_, res) => res.json(detectAllCli()));

    app.get('/api/quota', async (_, res) => {
        const claudeCreds = readClaudeCreds();
        const codexTokens = readCodexTokens();
        const geminiAccount = readGeminiAccount();
        const [claudeResult, codexResult, geminiResult, copilotResult] = await Promise.all([
            fetchClaudeUsage(claudeCreds),
            fetchCodexUsage(codexTokens),
            fetchGeminiUsage(geminiAccount),
            fetchCopilotQuota(),
        ]);

        const classify = (result: any, hasCreds: boolean) =>
            result ?? (hasCreds ? { error: true } : { authenticated: false });

        res.json({
            claude: classify(claudeResult, !!claudeCreds),
            codex: classify(codexResult, !!codexTokens),
            gemini: classify(geminiResult, !!geminiAccount),
            opencode: { authenticated: true },
            copilot: copilotResult ?? { authenticated: false },
        });
    });

    app.post('/api/copilot/refresh', requireAuth, async (_, res) => {
        try {
            const result = await refreshCopilotFromKeychain();
            res.json(result);
        } catch (e: unknown) {
            res.status(500).json({ ok: false, error: (e as Error).message });
        }
    });
}
