// ─── Discord Slash Commands ──────────────────────────
// Guild-scoped command registration + execution.

import { REST, Routes, SlashCommandBuilder, type Client, type ChatInputCommandInteraction } from 'discord.js';
import { settings } from '../core/config.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { makeCommandCtx } from '../cli/command-context.js';
import { normalizeLocale } from '../core/i18n.js';
import { resetFallbackState } from '../agent/spawn.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { getVisibleCommands } from '../command-contract/policy.js';
import type { DiscordSendableChannel } from './channel-types.js';
import { seedDefaultEmployees } from '../core/employees.js';

export async function registerDiscordSlashCommands(client: Client) {
    if (!settings.discord?.guildId) {
        console.warn('[discord] guildId not set — skipping slash command registration');
        return;
    }
    if (!client.application?.id) {
        console.warn('[discord] application id not available — skipping slash commands');
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
        const rest = new REST({ version: '10' }).setToken(settings.discord.token);
        await rest.put(
            Routes.applicationGuildCommands(client.application.id, settings.discord.guildId),
            { body: commands },
        );
        console.log(`[discord] registered ${commands.length} guild-scoped slash commands`);
    } catch (e) {
        console.error('[discord:commands]', (e as Error).message);
    }
}

function makeDiscordCommandCtx() {
    const locale = normalizeLocale(settings.locale, 'ko');
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
    });
}

export async function handleDiscordSlashCommand(interaction: ChatInputCommandInteraction) {
    const cmdText = `/${interaction.commandName} ${interaction.options.getString('args') ?? ''}`.trim();
    const parsed = parseCommand(cmdText);
    if (!parsed) {
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
        return;
    }
    const result = await executeCommand(parsed, makeDiscordCommandCtx());

    // Steer: reply then actually perform orchestration
    if (result?.type === 'steer' && result?.steerPrompt) {
        await interaction.reply(result.text || 'Redirecting...');
        // Fire orchestration in the channel (like Telegram's tgOrchestrate after steer)
        const channel = interaction.channel;
        if (channel && 'send' in channel) {
            const { orchestrateAndCollect } = await import('../orchestrator/collect.js');
            const { setLastActiveTarget } = await import('../messaging/runtime.js');
            const peerKind = interaction.guildId ? 'channel' as const : 'direct' as const;
            const target = {
                channel: 'discord' as const,
                targetKind: 'channel' as const,
                peerKind,
                targetId: interaction.channelId,
                guildId: interaction.guildId ?? undefined,
            };
            setLastActiveTarget('discord', target);
            try {
                const { chunkDiscordMessage } = await import('./forwarder.js');
                const text = String(await orchestrateAndCollect(result.steerPrompt, {
                    origin: 'discord', target, _skipInsert: true,
                }));
                const chunks = chunkDiscordMessage(text);
                for (const chunk of chunks) {
                    await (channel as unknown as DiscordSendableChannel).send(chunk);
                }
            } catch (err: unknown) {
                await (channel as unknown as DiscordSendableChannel).send(`❌ ${(err as Error).message}`).catch(() => { });
            }
        }
        return;
    }

    const text = result?.text || '(no output)';
    try {
        await interaction.reply(text.slice(0, 2000));
    } catch {
        await interaction.reply({ content: text.slice(0, 2000), ephemeral: true }).catch(() => { });
    }
}
