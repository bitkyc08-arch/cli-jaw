import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { ok } from '../http/response.js';
import { asyncHandler } from '../http/async-handler.js';
import { settings, JAW_HOME, detectAllCli } from '../core/config.js';
import { readCodexContextWindow } from '../core/codex-config.js';
import { regenerateB, A2_PATH, HEARTBEAT_PATH } from '../prompt/builder.js';
import { clearTemplateCache, getTemplateDir } from '../prompt/template-loader.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { CLI_REGISTRY, CLI_KEYS } from '../cli/registry.js';
import { readClaudeCreds, readCodexTokens, fetchClaudeUsage, fetchCodexUsage, readGeminiAccount, fetchGeminiUsage, fetchGrokStatus } from './quota.js';
import { fetchCursorUsage } from './quota-cursor-dashboard.js';
import { fetchAgyUsage } from './quota-agy-reverse.js';
import { fetchKiroUsage } from './quota-kiro-reverse.js';
import { fetchOpenCodeUsage } from './quota-opencode-go-api.js';
import { buildLiveCliRegistry } from '../cli/registry-live.js';
import { fetchCopilotQuota, refreshCopilotFromKeychain } from '../../lib/quota-copilot.js';
import { extractOpenAiApiKey, hasInvalidOpenAiApiKeyInput } from '../jaw-ceo/openai-key.js';
import { getSecurityAuditLog } from '../security/security-audit-log.js';
import { pickFolderNative } from '../core/folder-picker.js';
import { getProjectGitSummary } from '../project-git-summary.js';
import {
    listPiModels,
    normalizePiProfile,
    normalizePiSettings,
    redactPiSettings,
    type PiProfile,
} from '../agent/pi-runtime.js';

function redactSttSettings(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!input) return input;
    const gKey = String(input["geminiApiKey"] || process.env["GEMINI_API_KEY"] || '');
    const oKey = String(input["openaiApiKey"] || '');
    return {
        ...input,
        geminiApiKey: undefined,
        geminiKeySet: !!gKey,
        geminiKeyLast4: gKey.slice(-4) || '',
        openaiApiKey: undefined,
        openaiKeySet: !!oKey,
        openaiKeyLast4: oKey.slice(-4) || '',
    };
}

function redactJawCeoSettings(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!input) return input;
    const settingsKey = extractOpenAiApiKey(input["openaiApiKey"]);
    const envKey = extractOpenAiApiKey(process.env["OPENAI_API_KEY"]);
    const key = envKey || settingsKey;
    return {
        ...input,
        openaiApiKey: undefined,
        openaiKeySet: !!key,
        openaiKeyLast4: key.slice(-4) || '',
        openaiKeySource: envKey ? 'env' : settingsKey ? 'settings' : 'none',
        openaiKeyInvalid: hasInvalidOpenAiApiKeyInput(input["openaiApiKey"]),
    };
}

function redactRuntimeSettings<T extends Record<string, unknown>>(input: T): T {
    const safe = { ...input } as T & { stt?: Record<string, unknown>; jawCeo?: Record<string, unknown>; pi?: Record<string, unknown> };
    const stt = redactSttSettings(safe.stt);
    const jawCeo = redactJawCeoSettings(safe.jawCeo);
    const pi = redactPiSettings(safe.pi);
    if (stt) safe.stt = stt;
    else delete safe.stt;
    if (jawCeo) safe.jawCeo = jawCeo;
    else delete safe.jawCeo;
    if (pi) safe.pi = pi;
    else delete safe.pi;
    return safe as T;
}

function mergePiProfile(piInput: unknown, profile: PiProfile, models: string[]) {
    const pi = normalizePiSettings(piInput);
    const profiles = pi.profiles.filter((entry) => entry.id !== profile.id);
    profiles.push(profile);
    return {
        ...pi,
        defaultProfileId: profile.id,
        profiles,
        discoveredModels: {
            ...(pi.discoveredModels || {}),
            [profile.id]: models,
        },
    };
}

type QuotaStatusEntry = Record<string, unknown>;

function isQuotaStatusEntry(value: unknown): value is QuotaStatusEntry {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withQuotaMeta(result: unknown, meta: QuotaStatusEntry): QuotaStatusEntry {
    const base = isQuotaStatusEntry(result) ? result : {};
    return Object.fromEntries(
        Object.entries({ ...base, ...meta }).filter(([, value]) => value !== undefined),
    );
}

function buildStatusOnlyQuota(meta: QuotaStatusEntry): QuotaStatusEntry {
    return withQuotaMeta({
        authenticated: true,
        quotaCapable: false,
        windows: [],
    }, meta);
}

function resolveAiEQuotaProvider(): string {
    const provider = settings["perCli"]?.["ai-e"]?.provider;
    if (typeof provider === 'string' && provider.trim()) return provider;
    const entry = CLI_REGISTRY["ai-e"] as Record<string, unknown>;
    return typeof entry["defaultProvider"] === 'string' ? entry["defaultProvider"] as string : 'claude';
}

export function registerSettingsRoutes(
    app: Express,
    requireAuth: AuthMiddleware,
    applySettings: (patch: Record<string, unknown>) => Promise<unknown>,
    projectRoot: string,
): void {
    app.get('/api/settings', (_, res) => {
        const safe = redactRuntimeSettings(settings);
        ok(res, safe, safe);
    });

    app.put('/api/settings', requireAuth, asyncHandler(async (req, res) => {
        const result = await applySettings(req.body) as Record<string, unknown>;
        try {
            const keys = Object.keys(req.body || {}).filter(k => !['stt', 'jawCeo'].includes(k));
            getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), { keys });
        } catch { /* non-fatal */ }
        const safe = redactRuntimeSettings(result);
        ok(res, safe);
    }));

    // #233 follow-up: open the OS folder chooser and apply the picked folder
    // as the project root. The dialog blocks until the user answers, so the
    // request can stay open for minutes — that is expected.
    app.post('/api/project/pick', requireAuth, asyncHandler(async (req, res) => {
        const result = await pickFolderNative();
        if (result.status === 'busy') {
            res.status(409).json({ ok: false, error: 'folder dialog already open' });
            return;
        }
        if (result.status === 'cancelled') {
            ok(res, { cancelled: true });
            return;
        }
        if (result.status === 'unavailable') {
            res.status(500).json({ ok: false, error: result.reason });
            return;
        }
        const applied = await applySettings({ projectDirs: [result.path] }) as Record<string, unknown>;
        try {
            getSecurityAuditLog().append('settings_change', String(req.ip || 'local'), { keys: ['projectDirs'] });
        } catch { /* non-fatal */ }
        ok(res, { projectDirs: applied["projectDirs"] ?? null });
    }));

    app.get('/api/project/git-summary', requireAuth, asyncHandler(async (_req, res) => {
        res.json(await getProjectGitSummary(settings["projectDirs"]));
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
        if (content == null) {
            res.status(400).json({ error: 'content required' });
            return;
        }
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
        if (content == null || typeof content !== 'string') {
            res.status(400).json({ error: 'content required' });
            return;
        }
        const filename = req.params["id"] + '.md';
        if (!/^[a-z0-9-]+\.md$/.test(filename)) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
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
        if (content == null) {
            res.status(400).json({ error: 'content required' });
            return;
        }
        fs.writeFileSync(HEARTBEAT_PATH, content);
        res.json({ ok: true });
    });

    app.get('/api/mcp', (_req, res) => res.json(loadUnifiedMcp()));

    app.put('/api/mcp', requireAuth, (req, res) => {
        const config = req.body;
        if (!config || !config.servers) {
            res.status(400).json({ error: 'servers object required' });
            return;
        }
        saveUnifiedMcp(config);
        res.json({ ok: true, servers: Object.keys(config.servers) });
    });

    app.post('/api/mcp/sync', requireAuth, (_req, res) => {
        const config = loadUnifiedMcp();
        const results = syncToAll(config);
        res.json({ ok: true, results });
    });

    app.post('/api/mcp/install', requireAuth, async (_req, res) => {
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

    app.post('/api/mcp/reset', requireAuth, (_req, res) => {
        try {
            const mcpPath = join(JAW_HOME, 'mcp.json');
            if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
            const config = initMcpConfig(settings["workingDir"]);
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

    app.get('/api/mcp/registry', async (_, res) => {
        try {
            const { fetchMcpRegistry, fetchMcpRegistryLocal } = await import('../../lib/mcp/mcp-registry.js');
            const localCandidates = [
                join(JAW_HOME, 'mcp-ref', 'registry.json'),
                join(os.homedir(), 'Developer', 'new', '700_projects', 'mcp-ref', 'registry.json'),
            ];
            let result: Awaited<ReturnType<typeof fetchMcpRegistry>> = { entries: [], builtins: [] };
            for (const p of localCandidates) {
                result = fetchMcpRegistryLocal(p);
                if (result.entries.length) break;
            }
            if (!result.entries.length) result = await fetchMcpRegistry();
            res.json({ ok: true, ...result });
        } catch (e: unknown) {
            res.status(500).json({ ok: false, error: (e as Error).message, entries: [], builtins: [] });
        }
    });

    app.get('/api/cli-registry', asyncHandler(async (_, res) => {
        ok(res, await buildLiveCliRegistry());
    }));
    app.get('/api/cli-status', (_, res) => res.json(detectAllCli()));

    app.post('/api/pi/profiles/register', requireAuth, asyncHandler(async (req, res) => {
        const profile = normalizePiProfile(req.body);
        const nextPi = mergePiProfile(settings["pi"], profile, [profile.model]);
        const models = await listPiModels(nextPi, profile.id);
        if (!models.includes(profile.model)) {
            res.status(400).json({ ok: false, error: `Pi model discovery did not include ${profile.model}`, models });
            return;
        }
        const updated = await applySettings({
            pi: mergePiProfile(settings["pi"], profile, models),
            perCli: {
                pi: {
                    provider: profile.id,
                    model: profile.model,
                },
            },
        }) as Record<string, unknown>;
        const redactedProfile = redactPiSettings({ defaultProfileId: profile.id, profiles: [profile] })['profiles'];
        ok(res, {
            profile: Array.isArray(redactedProfile) ? redactedProfile[0] : null,
            models,
            settings: redactRuntimeSettings(updated),
        });
    }));

    app.get('/api/pi/models', requireAuth, asyncHandler(async (req, res) => {
        const profile = typeof req.query['profile'] === 'string' && req.query['profile'].trim()
            ? req.query['profile'].trim()
            : normalizePiSettings(settings["pi"]).defaultProfileId;
        const models = await listPiModels(settings["pi"], profile);
        ok(res, { profile, models });
    }));

    app.get('/api/quota', async (_, res) => {
        const claudeCreds = readClaudeCreds();
        const codexTokens = readCodexTokens();
        const geminiAccount = readGeminiAccount();
        const [claudeResult, codexResult, geminiResult, copilotResult, cursorQuota, agyQuota, kiroQuota, opencodeQuota] = await Promise.all([
            fetchClaudeUsage(claudeCreds),
            fetchCodexUsage(codexTokens),
            fetchGeminiUsage(geminiAccount),
            fetchCopilotQuota(),
            fetchCursorUsage(),
            fetchAgyUsage(),
            fetchKiroUsage(),
            fetchOpenCodeUsage(),
        ]);

        const classify = (result: unknown, hasCreds: boolean) =>
            result ?? (hasCreds ? { error: true } : { authenticated: false });

        const claudeQuota = classify(claudeResult, !!claudeCreds);
        const codexQuota = classify(codexResult, !!codexTokens);
        const geminiQuota = classify(geminiResult, !!geminiAccount);
        const grokQuota = await fetchGrokStatus();
        const copilotQuota = copilotResult ?? { authenticated: false };
        const opencodeQuotaResolved = opencodeQuota ?? buildStatusOnlyQuota({
            quotaSource: 'not-exposed-by-opencode-cli',
            displayTier: 'OpenCode',
            account: { type: 'opencode', tier: 'auth/status only' },
        });
        const providerQuota: Record<string, unknown> = {
            claude: claudeQuota,
            codex: codexQuota,
            gemini: geminiQuota,
            grok: grokQuota,
            copilot: copilotQuota,
            kiro: kiroQuota,
        };
        const aiEProvider = resolveAiEQuotaProvider();
        const aiEQuota = withQuotaMeta(providerQuota[aiEProvider] ?? buildStatusOnlyQuota({
            quotaSource: 'unknown-ai-e-provider',
            displayTier: 'AI-E',
        }), {
            quotaSource: `ai-e:${aiEProvider}`,
            displayTier: `AI-E → ${aiEProvider}`,
            delegatedProvider: aiEProvider,
        });
        const quotaByCli: Record<string, unknown> = {
            agy: agyQuota,
            'ai-e': aiEQuota,
            claude: claudeQuota,
            'claude-e': withQuotaMeta(claudeQuota, {
                quotaSource: 'claude-e:underlying-claude',
                displayTier: 'Claude E → Claude',
                delegatedProvider: 'claude',
            }),
            codex: codexQuota,
            'codex-app': withQuotaMeta(codexQuota, {
                quotaSource: 'codex-app:underlying-codex',
                displayTier: 'Codex App → Codex',
                delegatedProvider: 'codex',
            }),
            cursor: cursorQuota,
            'kiro-code': kiroQuota,
            gemini: geminiQuota,
            grok: grokQuota,
            opencode: opencodeQuotaResolved,
            copilot: copilotQuota,
        };
        res.json(Object.fromEntries(CLI_KEYS.map((key) => [key, quotaByCli[key] ?? { authenticated: false }])));
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
