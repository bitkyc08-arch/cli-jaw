import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { settings } from '../core/config.js';
import { chunkDiscordMessage } from './forwarder.js';
import { validateDiscordFileSize } from './discord-file.js';
import { redactOutboundText } from '../messaging/redact.js';

export type DiscordSendClientResult =
    | { token: string; reason?: never; status?: never }
    | { token: null; reason: string; status: 400 | 503 };

export function invalidateDiscordSendClient(): void {
    // no-op: token is read fresh from settings each call
}

export function getDiscordSendClient(): DiscordSendClientResult {
    const dc = settings["discord"];
    if (!dc?.enabled) {
        return { token: null, reason: 'discord_disabled', status: 503 };
    }
    const token = typeof dc.token === 'string' ? dc.token.trim() : '';
    if (!token) {
        return { token: null, reason: 'discord_token_missing', status: 503 };
    }
    return { token };
}

async function discordRestJson(token: string, path: string, init: RequestInit): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
        const response = await fetch(`https://discord.com/api/v10${path}`, {
            ...init,
            headers: {
                Authorization: `Bot ${token}`,
                ...(init.headers || {}),
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            return { ok: false, error: body || response.statusText, status: response.status };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: (error as Error).message, status: 502 };
    }
}

export async function sendDiscordTextRest(token: string, channelId: string, text: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    const chunks = chunkDiscordMessage(text);
    for (const chunk of chunks) {
        const result = await discordRestJson(token, `/channels/${encodeURIComponent(channelId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: chunk }),
        });
        if (!result.ok) return result;
    }
    return { ok: true };
}

export async function sendDiscordFileRest(
    token: string,
    channelId: string,
    filePath: string,
    caption?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
        const buffer = await readFile(filePath);
        validateDiscordFileSize(filePath, buffer.length);
        const form = new FormData();
        form.append('files[0]', new Blob([buffer]), basename(filePath));
        if (caption?.trim()) {
            form.append('payload_json', JSON.stringify({ content: redactOutboundText(caption.trim()) }));
        }
        const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${token}` },
            body: form,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            return { ok: false, error: body || response.statusText, status: response.status };
        }
        return { ok: true };
    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        return { ok: false, error: (error as Error).message, status: statusCode || 502 };
    }
}
