// ─── Discord Slash Commands ──────────────────────────
// Guild-scoped command registration + execution.

import { REST, Routes, SlashCommandBuilder, type Client, type ChatInputCommandInteraction } from 'discord.js';
import { settings } from '../core/config.js';
import { getActiveChatSession, resolveOrCreateRemoteSession } from '../core/chat-sessions.js';
import { withSessionScope } from '../core/session-context.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import { channelGateOn, scopeForChatSession } from '../orchestrator/scope.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { authorizePrivilegedRemote, isPrivilegedRemoteCommand } from '../cli/handlers/remote-session-commands.js';
import { makeCommandCtx } from '../cli/command-context.js';
import { normalizeLocale } from '../core/i18n.js';
import { resetFallbackState } from '../agent/spawn.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { bumpGenerationForSessionLocalReset, bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { getVisibleCommands } from '../command-contract/policy.js';
import { asSendable } from './channel-types.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';
import { log } from '../core/logger.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';

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
        log.error('[discord:commands]', logErrorText(e));
    }
}

function makeDiscordCommandCtx() {
    const locale = normalizeLocale(settings["locale"], 'ko');
    return makeCommandCtx('discord', locale, {
        applySettings: async (patch) => {
            bumpSessionOwnershipGeneration();
            return applyRuntimeSettingsPatch(patch, {
                resetFallbackState: () => resetFallbackState(null),
            });
        },
        clearSession: () => {
            bumpGenerationForSessionLocalReset();
            clearMainSessionState();
        },
        resetSession: () => {
            bumpGenerationForSessionLocalReset();
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
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const gateOn = multiSessionEnabled && channelGateOn('discord');
    const peerKind = interaction.guildId ? 'channel' as const : 'direct' as const;
    const target = stripUndefined({
        channel: 'discord' as const,
        targetKind: 'channel' as const,
        peerKind,
        targetId: interaction.channelId,
        guildId: interaction.guildId ?? undefined,
    });
    const remoteKey = multiSessionEnabled && gateOn ? buildRemoteBindingKey(target) : undefined;
    const chatSessionId = multiSessionEnabled && !gateOn
        ? 'default'
        : remoteKey ? resolveOrCreateRemoteSession(remoteKey) : getActiveChatSession();
    const scope = scopeForChatSession(chatSessionId, remoteKey, gateOn);
    const cmdName = parsed.type === 'known' ? (parsed.cmd?.name ?? parsed.name) : parsed.name;
    if (isPrivilegedRemoteCommand(cmdName)) {
        const auth = authorizePrivilegedRemote(cmdName, {
            channel: 'discord',
            actorId: interaction.user.id,
            conversationKey: remoteKey || interaction.channelId,
            chatSessionId,
        });
        if (!auth.ok) {
            await interaction.editReply(redactOutboundText(auth.text));
            return;
        }
    }
    const result = await withSessionScope({ scope, chatSessionId },
        () => executeCommand(parsed, makeDiscordCommandCtx()));

    if (result?.steerPrompt) {
        await interaction.editReply(redactOutboundText(result.text || 'Redirecting...'));
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
                await channel.send(`❌ ${userErrorText(err)}`).catch(() => { });
            }
        }
        return;
    }

    const text = result?.text || '(no output)';
    await interaction.editReply(redactOutboundText(text).slice(0, 2000));
}
