// ─── Unified CommandContext factory ──────────────────
// Replaces makeWebCommandCtx (server.ts) and makeTelegramCommandCtx (bot.ts).
// Interface-specific behavior is handled via the `interface` parameter.

import fs from 'fs';
import { join } from 'path';
import { settings, detectAllCli, APP_VERSION, JAW_HOME } from '../core/config.js';
import { getSession, clearMessages, updateSession } from '../core/db.js';
import { broadcast } from '../core/bus.js';
import { t, normalizeLocale } from '../core/i18n.js';
import { getMergedSkills, A2_PATH, regenerateB } from '../prompt/builder.js';
import { activeProcess, messageQueue } from '../agent/spawn.js';
import * as browser from '../browser/index.js';
import * as memory from '../memory/memory.js';
import {
    loadUnifiedMcp, saveUnifiedMcp, syncToAll,
    ensureSkillsSymlinks, copyDefaultSkills,
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
            // Telegram: only fallbackOrder allowed
            if (iface === 'telegram') {
                if (patch.fallbackOrder !== undefined && Object.keys(patch).length === 1) {
                    return deps.applySettings(patch);
                }
                return { ok: false, text: t('tg.settingsUnsupported', {}, locale) };
            }
            return deps.applySettings(patch);
        },
        getRuntime: () => ({
            uptimeSec: Math.floor(process.uptime()),
            activeAgent: !!activeProcess,
            queuePending: messageQueue.length,
        }),
        getSkills: () => getMergedSkills(),
        clearSession: async () => deps.clearSession(),
        getCliStatus: () => detectAllCli(),

        // MCP — unified across all interfaces (TG previously returned empty)
        getMcp: () => loadUnifiedMcp(),
        syncMcp: async () => ({ results: syncToAll(loadUnifiedMcp(), settings.workingDir) }),
        installMcp: async () => {
            const config = loadUnifiedMcp();
            const { installMcpServers } = await import('../../lib/mcp-sync.js');
            const results = await installMcpServers(config);
            saveUnifiedMcp(config);
            const synced = syncToAll(config, settings.workingDir);
            return { results, synced };
        },

        // Memory
        listMemory: () => memory.list(),
        searchMemory: (q: any) => memory.search(q),

        // Browser
        getBrowserStatus: async () => browser.getBrowserStatus(settings.browser?.cdpPort || 9240),
        getBrowserTabs: async () => ({ tabs: await browser.listTabs(settings.browser?.cdpPort || 9240) }),

        // Employees
        resetEmployees: deps.resetEmployees
            ? async () => deps.resetEmployees!()
            : undefined,

        // Skills — unified (TG previously missing)
        resetSkills: async () => {
            // Clear before recopy (parity with CLI skill reset)
            const activeDir = join(JAW_HOME, 'skills');
            const refDir = join(JAW_HOME, 'skills_ref');
            if (fs.existsSync(activeDir)) fs.rmSync(activeDir, { recursive: true, force: true });
            if (fs.existsSync(refDir)) fs.rmSync(refDir, { recursive: true, force: true });
            fs.mkdirSync(activeDir, { recursive: true });
            fs.mkdirSync(refDir, { recursive: true });
            copyDefaultSkills();
            const symlinks = ensureSkillsSymlinks(settings.workingDir, { onConflict: 'backup' });
            regenerateB();
            return { symlinks };
        },

        // Prompt
        getPrompt: () => {
            const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
            return { content: a2 };
        },
    };
}
