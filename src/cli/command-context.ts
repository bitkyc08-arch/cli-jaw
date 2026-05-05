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
import { searchMemoryWithPolicy } from '../memory/injection.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    runSkillReset,
} from '../../lib/mcp-sync.js';

import type { RemoteInterface } from '../messaging/types.js';

export type CommandContextInterface = 'web' | 'cli' | RemoteInterface;

export type CommandContextDeps = {
    /** Apply settings patch (server.ts provides full logic, TG provides restricted subset) */
    applySettings: (patch: Record<string, unknown>) => unknown;
    /** Clear session state callback (deletes messages + clears UI) */
    clearSession: () => void;
    /** Reset session without clearing messages (preserves chat history) */
    resetSession?: () => void;
    /** Seed default employees callback */
    resetEmployees?: () => unknown;
};

// Remote interface에서 허용하는 settings patch 키
const REMOTE_ALLOWED_SETTINGS_KEYS = new Set([
    'fallbackOrder',  // /fallback
    'cli',            // /cli
    'perCli',         // /model
    'showReasoning',  // /thought
    'memory',         // /flush
    'telegram',       // /forward (telegram)
    'discord',        // /forward (discord)
]);

export type CliCommandContext = ReturnType<typeof makeCommandCtx>;

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
        updateSettings: async (patch: Record<string, unknown>) => {
            // Remote interfaces: allow curated subset of runtime-setting keys
            if (iface === 'telegram' || iface === 'discord') {
                const keys = Object.keys(patch);
                const allAllowed = keys.length > 0
                    && keys.every(k => REMOTE_ALLOWED_SETTINGS_KEYS.has(k));
                if (allAllowed) {
                    return deps.applySettings(patch);
                }
                const msgKey = iface === 'discord' ? 'dc.settingsUnsupported' : 'tg.settingsUnsupported';
                return { ok: false, text: t(msgKey, {}, locale) };
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
        resetSession: deps.resetSession
            ? async () => deps.resetSession!()
            : async () => deps.clearSession(),
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
        searchMemory: (q: string) => searchMemoryWithPolicy({
            query: String(q || ''),
            role: 'read_only_tool',
        }),
        getMemoryStatus: () => getMemoryStatus(),
        initMemoryRuntime: () => ensureMemoryStructure(),
        bootstrapMemory: (options?: Record<string, unknown>) => bootstrapMemory(options || {}),
        reindexMemory: () => reindexMemory(),
        getAdvancedMemoryStatus: () => getMemoryStatus(),
        initAdvancedMemory: () => ensureMemoryStructure(),
        bootstrapAdvancedMemory: (options?: Record<string, unknown>) => bootstrapMemory(options || {}),
        reindexAdvancedMemory: () => reindexMemory(),
        validateAdvancedMemoryConfig: async () => ({ ok: true, provider: 'integrated', error: '' }),

        // Browser
        getBrowserStatus: async () => browser.getBrowserStatus(settings["browser"]?.cdpPort || deriveCdpPort()),
        getBrowserTabs: async () => ({ tabs: await browser.listTabs(settings["browser"]?.cdpPort || deriveCdpPort()) }),

        // Employees
        resetEmployees: deps.resetEmployees
            ? async () => deps.resetEmployees!()
            : undefined,

        // Skills — unified (TG previously missing)
        resetSkills: async (mode: 'soft' | 'hard' = 'soft') => {
            const result = runSkillReset({
                mode,
                repairTargetDir: settings["workingDir"],
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
