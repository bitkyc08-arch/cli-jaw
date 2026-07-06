// ─── Discord Slash Commands ──────────────────────────
// Guild-scoped command registration + execution.

import { REST, Routes, SlashCommandBuilder, type Client, type ChatInputCommandInteraction } from 'discord.js';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { makeCommandCtx } from '../cli/command-context.js';
import { normalizeLocale } from '../core/i18n.js';
import { resetFallbackState } from '../agent/spawn.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { getVisibleCommands } from '../command-contract/policy.js';
import { asSendable } from './channel-types.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';
import { log } from '../core/logger.js';

export async function registerDiscordSlashCommands(client: Client) {
    if (!settings["discord"]?.guildId) {
        log.warn('[discord] guildId not set — skipping slash command registration');
        return;
    }
    if (!client.application?.id) {
        log.warn('[discord] application id not available — skipping slash commands');
        return;
    }

    const discordCommands = getVisibleCommands('discord');
    const commands = discordCommands.map(c =>
        new SlashCommandBuilder()
            .setName(c.name)
            .setDescription((c as { desc?: string }).desc || `/${c.name}`)
            .addStringOption(opt =>
                opt.setName('args').setDescription('Arguments').setRequired(false)
            )
            .toJSON()
    );

    try {
        const rest = new REST({ version: '10' }).setToken(settings["discord"].token);
        await rest.put(
            Routes.applicationGuildCommands(client.application.id, settings["discord"].guildId),
            { body: commands },
        );
        log.info(`[discord] registered ${commands.length} guild-scoped slash commands`);
    } catch (e) {
        log.error('[discord:commands]', (e as Error).message);
    }
}

function makeDiscordCommandCtx() {
    const locale = normalizeLocale(settings["locale"], 'ko');
    return makeCommandCtx('discord', locale, {
        applySettings: async (patch) => {
            bumpSessionOwnershipGeneration();
            return applyRuntimeSettingsPatch(patch, {
                resetFallbackState,
            });
        },
        clearSession: () => {
            bumpSessionOwnershipGeneration();
            clearMainSessionState();
        },
        resetSession: () => {
            bumpSessionOwnershipGeneration();
            resetSessionPreservingHistory();
        },
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
        resetEmployeeSessions: () => resetEmployeeSessions(),
    });
}

export async function handleDiscordSlashCommand(interaction: ChatInputCommandInteraction) {
    const cmdText = `/${interaction.commandName} ${interaction.options.getString('args') ?? ''}`.trim();
    const parsed = parseCommand(cmdText);
    if (!parsed) {
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
        return;
    }

    await interaction.deferReply();
    const result = await executeCommand(parsed, makeDiscordCommandCtx());

    if (result?.steerPrompt) {
        await interaction.editReply(result.text || 'Redirecting...');
        const channel = asSendable(interaction.channel);
        if (channel) {
            const { orchestrateAndCollect } = await import('../orchestrator/collect.js');
            const { setLastActiveTarget } = await import('../messaging/runtime.js');
            const peerKind = interaction.guildId ? 'channel' as const : 'direct' as const;
            const target = stripUndefined({
                channel: 'discord' as const,
                targetKind: 'channel' as const,
                peerKind,
                targetId: interaction.channelId,
                guildId: interaction.guildId ?? undefined,
            });
            setLastActiveTarget('discord', target);
            try {
                const { chunkDiscordMessage } = await import('./forwarder.js');
                const text = String(await orchestrateAndCollect(result.steerPrompt, {
                    origin: 'discord', target, _skipInsert: true,
                }));
                const chunks = chunkDiscordMessage(text);
                for (const chunk of chunks) {
                    await channel.send(chunk);
                }
            } catch (err: unknown) {
                await channel.send(`❌ ${(err as Error).message}`).catch(() => { });
            }
        }
        return;
    }

    const text = result?.text || '(no output)';
    await interaction.editReply(text.slice(0, 2000));
}
