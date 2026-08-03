import { settings } from '../core/config.js';
import { shouldAttachSlack } from '../slack/events.js';
import { getActiveChannel } from './runtime.js';
import type { MessengerChannel } from './types.js';

export type TransportCapability = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type ChannelHealthSnapshot = {
    activeInbound: MessengerChannel;
    telegram: TransportCapability;
    discord: TransportCapability;
    slack: TransportCapability;
};

function telegramHasSendTarget(): boolean {
    const tg = settings["telegram"];
    if (tg?.allowedChatIds?.length) return true;
    const messaging = settings["messaging"] as Record<string, unknown> | undefined;
    const last = messaging?.['lastActive'] as Record<string, unknown> | undefined;
    const telegramLast = last?.['telegram'] as { targetId?: string } | undefined;
    return Boolean(telegramLast?.targetId);
}

function discordHasSendTarget(): boolean {
    const dc = settings["discord"];
    if (dc?.channelIds?.length) return true;
    const messaging = settings["messaging"] as Record<string, unknown> | undefined;
    const last = messaging?.['lastActive'] as Record<string, unknown> | undefined;
    const discordLast = last?.['discord'] as { targetId?: string } | undefined;
    return Boolean(discordLast?.targetId);
}

function slackHasSendTarget(): boolean {
    const sc = settings["slack"];
    if (sc?.channelIds?.length) return true;
    const messaging = settings["messaging"] as Record<string, unknown> | undefined;
    const last = messaging?.['lastActive'] as Record<string, unknown> | undefined;
    const slackLast = last?.['slack'] as { targetId?: string } | undefined;
    return Boolean(slackLast?.targetId);
}

export function getTransportCapability(channel: MessengerChannel): TransportCapability {
    const activeInbound = getActiveChannel() === channel;
    if (channel === 'telegram') {
        const tg = settings["telegram"];
        const token = typeof tg?.token === 'string' ? tg.token.trim() : '';
        const configured = Boolean(tg?.enabled && token);
        if (!configured) {
            return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
        }
        if (!telegramHasSendTarget()) {
            return { configured: true, activeInbound, sendCapable: false, reason: 'missing_chat_id' };
        }
        return { configured: true, activeInbound, sendCapable: true };
    }

    if (channel === 'slack') {
        const sc = settings["slack"];
        const botToken = typeof sc?.botToken === 'string' ? sc.botToken.trim() : '';
        const appToken = typeof sc?.appToken === 'string' ? sc.appToken.trim() : '';
        if (!sc?.enabled || !botToken) {
            return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
        }
        if (!shouldAttachSlack(sc.attachPort, settings["port"])) {
            // Tokens are present but this instance must not open the socket —
            // surface WHY instead of looking broken.
            return { configured: true, activeInbound: false, sendCapable: false, reason: 'not_attach_instance' };
        }
        if (!appToken) {
            // Outbound-only: the Web API works with just the bot token, but no
            // inbound events can arrive without the app-level socket token.
            return {
                configured: true,
                activeInbound,
                sendCapable: slackHasSendTarget(),
                reason: 'missing_app_token',
            };
        }
        if (!slackHasSendTarget()) {
            return { configured: true, activeInbound, sendCapable: false, reason: 'missing_channel_id' };
        }
        return { configured: true, activeInbound, sendCapable: true };
    }

    const dc = settings["discord"];
    const token = typeof dc?.token === 'string' ? dc.token.trim() : '';
    const guildId = typeof dc?.guildId === 'string' ? dc.guildId.trim() : '';
    const configured = Boolean(dc?.enabled && token && guildId);
    if (!configured) {
        return { configured: false, activeInbound, sendCapable: false, reason: 'disabled' };
    }
    if (!discordHasSendTarget()) {
        return { configured: true, activeInbound, sendCapable: false, reason: 'missing_channel_id' };
    }
    return { configured: true, activeInbound, sendCapable: true };
}

export function buildChannelHealthSnapshot(): ChannelHealthSnapshot {
    return {
        activeInbound: getActiveChannel(),
        telegram: getTransportCapability('telegram'),
        discord: getTransportCapability('discord'),
        slack: getTransportCapability('slack'),
    };
}
