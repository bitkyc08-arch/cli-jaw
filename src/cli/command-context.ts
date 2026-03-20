// ─── Unified CommandContext factory ──────────────────
// Replaces makeWebCommandCtx (server.ts) and makeTelegramCommandCtx (bot.ts).
// Interface-specific behavior is handled via the `interface` parameter.

import fs from 'fs';
import { settings, detectAllCli, APP_VERSION, deriveCdpPort } from '../core/config.js';
import { getSession, clearMessages, updateSession } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { getMergedSkills, A2_PATH, regenerateB } from '../prompt/builder.js';
import { isAgentBusy, messageQueue } from '../agent/spawn.js';
import * as browser from '../browser/index.js';
import * as memory from '../memory/memory.js';
import { bootstrapMemory, ensureMemoryStructure, getMemoryStatus, reindexMemory, searchIndexedMemory } from '../memory/runtime.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    runSkillReset,
} from '../../lib/mcp-sync.js';

export type CommandContextInterface = 'web' | 'telegram' | 'cli';

export type CommandContextDeps = {
    /** Apply settings patch (server.ts provides full logic, TG provides restricted subset) */
    applySettings: (patch: Record<string, any>) => any;
    /** Clear session state callback */
    clearSession: () => void;
    /** Seed default employees callback */
    resetEmployees?: () => any;
};

// Telegram에서 허용하는 settings patch 키
const TG_ALLOWED_SETTINGS_KEYS = new Set([
    'fallbackOrder',  // /fallback
    'cli',            // /cli
    'perCli',         // /model
    'memory',         // /flush
    'telegram',       // /forward
]);

export function makeCommandCtx(
    iface: CommandContextInterface,
    locale: string,
    deps: CommandContextDeps,
) {
    return {
        interface: iface,
        locale,
        version: APP_VERSION,
        getSession,
        getSettings: () => settings,
        updateSettings: async (patch: Record<string, any>) => {
            // Telegram: allow curated subset of runtime-setting keys
            if (iface === 'telegram') {
                const keys = Object.keys(patch);
                const allAllowed = keys.length > 0
                    && keys.every(k => TG_ALLOWED_SETTINGS_KEYS.has(k));
                if (allAllowed) {
                    return deps.applySettings(patch);
                }
                return { ok: false, text: t('tg.settingsUnsupported', {}, locale) };
            }
            return deps.applySettings(patch);
        },
        getRuntime: () => ({
            uptimeSec: Math.floor(process.uptime()),
            activeAgent: isAgentBusy(),
            queuePending: messageQueue.length,
        }),
        getSkills: () => getMergedSkills(),
        clearSession: async () => deps.clearSession(),
        getCliStatus: () => detectAllCli(),

        // MCP — unified across all interfaces (TG previously returned empty)
        getMcp: () => loadUnifiedMcp(),
        syncMcp: async () => ({ results: syncToAll(loadUnifiedMcp()) }),
        installMcp: async () => {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('../../lib/mcp-sync.js');
            const results = await installMcpServers(config);
            saveUnifiedMcp(config);
            const synced = syncToAll(config);
            return { results, synced };
        },

        // Memory
        listMemory: () => memory.list(),
        searchMemory: (q: any) => {
            const status = getMemoryStatus();
            return status.enabled && status.routing?.searchRead === 'advanced'
                ? searchIndexedMemory(String(q || ''))
                : memory.search(q);
        },
        getMemoryStatus: () => getMemoryStatus(),
        initMemoryRuntime: () => ensureMemoryStructure(),
        bootstrapMemory: (options?: Record<string, any>) => bootstrapMemory(options || {}),
        reindexMemory: () => reindexMemory(),
        getAdvancedMemoryStatus: () => getMemoryStatus(),
        initAdvancedMemory: () => ensureMemoryStructure(),
        bootstrapAdvancedMemory: (options?: Record<string, any>) => bootstrapMemory(options || {}),
        reindexAdvancedMemory: () => reindexMemory(),
        validateAdvancedMemoryConfig: async () => ({ ok: true, provider: 'integrated', error: '' }),

        // Browser
        getBrowserStatus: async () => browser.getBrowserStatus(settings.browser?.cdpPort || deriveCdpPort()),
        getBrowserTabs: async () => ({ tabs: await browser.listTabs(settings.browser?.cdpPort || deriveCdpPort()) }),

        // Employees
        resetEmployees: deps.resetEmployees
            ? async () => deps.resetEmployees!()
            : undefined,

        // Skills — unified (TG previously missing)
        resetSkills: async (mode: 'soft' | 'hard' = 'soft') => {
            const result = runSkillReset({
                mode,
                repairTargetDir: settings.workingDir,
                includeClaude: true,
            });
            regenerateB();
            return result;
        },

        // Prompt
        getPrompt: () => {
            const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
            return { content: a2 };
        },
    };
}
