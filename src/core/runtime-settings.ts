import {
    loadUnifiedMcp, syncToAll,
    ensureWorkingDirSkillsLinks, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { syncCodexContextWindow } from './codex-config.js';
import { settings, replaceSettings, saveSettings, migrateSettings, normalizeProjectDirs } from './config.js';
import { broadcast } from './bus.js';
import { syncMainSessionToSettings } from './main-session.js';
import { mergeSettingsPatch } from './settings-merge.js';
import { regenerateB } from '../prompt/builder.js';
import { restartMessagingRuntime, initActiveMessagingRuntime } from '../messaging/runtime.js';
import { beginRuntimeSettingsMutation } from './runtime-settings-gate.js';
import { resolveAiEProvider } from '../agent/args.js';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function syncJwcConfigDefault(currentSettings: Record<string, any>): void {
    try {
        const cli = currentSettings["cli"];
        if (cli !== 'jwc') return;
        const ao = currentSettings["activeOverrides"]?.['jwc'] as Record<string, string> | undefined;
        const pc = currentSettings["perCli"]?.['jwc'] as Record<string, string> | undefined;
        const model = ao?.['model'] || pc?.['model'] || 'claude-sonnet-4-6';
        const provider = ao?.['provider'] || pc?.['provider'] || 'anthropic';
        const modelRole = provider !== 'anthropic' ? `${provider}/${model}` : `${provider}/${model}`;
        const agentDir = process.env['CLI_JAW_JWC_AGENT_DIR'] || join(homedir(), '.jwc', 'agent');
        const configPath = join(agentDir, 'config.yml');
        let content: string;
        try {
            content = readFileSync(configPath, 'utf8');
        } catch {
            mkdirSync(agentDir, { recursive: true });
            content = '';
        }
        const defaultLine = `  default: ${modelRole}`;
        if (content.includes('modelRoles:')) {
            content = content.replace(
                /modelRoles:\s*\n\s*default:\s*.+/,
                `modelRoles:\n${defaultLine}`,
            );
        } else {
            content = `modelRoles:\n${defaultLine}\n${content}`;
        }
        writeFileSync(configPath, content, 'utf8');
    } catch (e: unknown) {
        console.error('[jaw:jwc-config]', (e as Error).message);
    }
}

type ApplyRuntimeSettingsOptions = {
    resetFallbackState?: () => void;
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

function selectedModelForCli(cli: string, currentSettings: Record<string, unknown>): string {
    const activeOverrides = asRecord(currentSettings["activeOverrides"]);
    const perCli = asRecord(currentSettings["perCli"]);
    return stringField(asRecord(activeOverrides[cli]), 'model')
        || stringField(asRecord(perCli[cli]), 'model')
        || 'default';
}

function selectedAiEProvider(currentSettings: Record<string, unknown>): string {
    const activeOverrides = asRecord(currentSettings["activeOverrides"]);
    const perCli = asRecord(currentSettings["perCli"]);
    const ao = asRecord(activeOverrides['ai-e']);
    const pc = asRecord(perCli['ai-e']);
    const explicitProvider = stringField(pc, 'provider') || stringField(ao, 'provider') || undefined;
    return resolveAiEProvider(explicitProvider, selectedModelForCli('ai-e', currentSettings));
}

function transportConfigFingerprint(channel: 'telegram' | 'discord', snapshot: Record<string, unknown>): string {
    const block = asRecord(snapshot[channel]);
    if (channel === 'telegram') {
        return JSON.stringify({
            enabled: block["enabled"],
            token: stringField(block, 'token'),
            allowedChatIds: block["allowedChatIds"],
        });
    }
    return JSON.stringify({
        enabled: block["enabled"],
        token: stringField(block, 'token'),
        guildId: stringField(block, 'guildId'),
        channelIds: block["channelIds"],
    });
}

async function invalidateSendOnlyClientsIfNeeded(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (transportConfigFingerprint('telegram', prev) !== transportConfigFingerprint('telegram', next)) {
        tasks.push(import('../telegram/bot.js').then(({ invalidateTelegramSendClient }) => {
            invalidateTelegramSendClient();
        }));
    }
    if (transportConfigFingerprint('discord', prev) !== transportConfigFingerprint('discord', next)) {
        tasks.push(import('../discord/send-only-client.js').then(({ invalidateDiscordSendClient }) => {
            invalidateDiscordSendClient();
        }));
    }
    await Promise.all(tasks);
}

export async function applyRuntimeSettingsPatch(
    rawPatch: Record<string, any> = {},
    opts: ApplyRuntimeSettingsOptions = {},
): Promise<Record<string, any>> {
    const finishSettingsMutation = beginRuntimeSettingsMutation();
    const prevCli = settings["cli"];
    const prevWorkingDir = settings["workingDir"];
    const prevSnapshot = { ...settings };
    const prevAiEProvider = selectedAiEProvider(prevSnapshot);

    try {
        const merged = mergeSettingsPatch(settings, rawPatch);
        if ('projectDirs' in rawPatch) {
            merged["projectDirs"] = normalizeProjectDirs(merged["projectDirs"]);
        }
        const migrated = migrateSettings(merged);
        replaceSettings(migrated);
        saveSettings(settings);

        if (rawPatch["perCli"]?.codex && 'contextWindow' in rawPatch["perCli"].codex) {
            const codexCfg = settings["perCli"]?.codex || {};
            syncCodexContextWindow({
                enabled: !!codexCfg.contextWindow,
                contextWindow: codexCfg.contextWindowSize || 1000000,
                compactLimit: codexCfg.contextCompactLimit || 900000,
            });
        }

        opts.resetFallbackState?.();

        // CLI-changed branch delegates main-session clearing to cliSwitchRefresh
        // (which writes a cleared row inside its DB transaction). On refresh failure
        // we revert settings; the original session row is preserved because nothing
        // touched it on this branch (no syncMainSessionToSettings call).
        const cliChanged = !!(prevCli && settings["cli"] && prevCli !== settings["cli"]);
        const nextAiEProvider = selectedAiEProvider(settings);
        const aiEProviderChanged = prevCli === 'ai-e'
            && settings["cli"] === 'ai-e'
            && prevAiEProvider !== nextAiEProvider;
        if (cliChanged || aiEProviderChanged) {
            const toCli = settings["cli"];
            const toModel = selectedModelForCli(toCli, settings);
            try {
                const { cliSwitchRefresh } = await import('./compact.js');
                await cliSwitchRefresh({
                    sourceWorkDir: prevWorkingDir || '',
                    targetWorkDir: settings["workingDir"] || '',
                    fromCli: aiEProviderChanged ? `ai-e:${prevAiEProvider}` : prevCli,
                    toCli,
                    toModel,
                    toProvider: toCli === 'ai-e' ? nextAiEProvider : undefined,
                });
            } catch (e: unknown) {
                console.error('[runtime-settings] cli switch refresh failed, rolling back:', (e as Error).message);
                replaceSettings(prevSnapshot);
                saveSettings(prevSnapshot);
                throw e;
            }
        } else {
            syncMainSessionToSettings(prevCli);
        }

        syncJwcConfigDefault(settings);

        if (settings["workingDir"] !== prevWorkingDir) {
            try {
                initMcpConfig(settings["workingDir"]);
                ensureWorkingDirSkillsLinks(settings["workingDir"], { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
                syncToAll(loadUnifiedMcp());
                regenerateB();
                console.log(`[jaw:workingDir] artifacts regenerated for ${settings["workingDir"]}`);
            } catch (e: unknown) {
                console.error('[jaw:workingDir]', (e as Error).message);
            }
        }

        await invalidateSendOnlyClientsIfNeeded(prevSnapshot, settings);

        // Unified messaging runtime restart (handles both Telegram and Discord)
        try {
            await restartMessagingRuntime(prevSnapshot, settings, rawPatch);
        } catch (e: unknown) {
            // Rollback: restore previous settings AND attempt to re-init previous runtime
            console.error('[runtime-settings] restart failed, rolling back:', (e as Error).message);
            replaceSettings(prevSnapshot);
            saveSettings(prevSnapshot);
            try {
                await initActiveMessagingRuntime();
            } catch (reInitErr: unknown) {
                console.error('[runtime-settings] rollback re-init also failed:', (reInitErr as Error).message);
            }
            throw e;
        }

        broadcast('settings_change', {
            changedKeys: Object.keys(rawPatch),
            cli: settings["cli"],
            model: selectedModelForCli(settings["cli"], settings),
            projectDirs: settings["projectDirs"] ?? null,
            source: 'apply',
        });

        return settings;
    } finally {
        finishSettingsMutation();
    }
}
