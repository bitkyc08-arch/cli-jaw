// ─── Discord File Send ───────────────────────────────
// Outbound file delivery for Discord.
// Default 10 MiB cap matches Discord's non-Nitro/non-boosted limit.
// Boosted servers (Level 2+) allow up to 50 MiB — adjust DISCORD_LIMITS if needed.

import type { Client } from 'discord.js';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RemoteTarget } from '../messaging/types.js';
import { asSendable } from './channel-types.js';
import { redactOutboundText, userErrorText } from '../messaging/redact.js';
import { sendDiscordFileRest } from './send-only-client.js';

export const DISCORD_LIMITS = {
    document: 10 * 1024 * 1024,
    photo: 10 * 1024 * 1024,
    voice: 10 * 1024 * 1024,
};

export function validateDiscordFileSize(_filePath: string, size: number) {
    // Slack has refused these since it shipped. Discord only checked the upper
    // bound, so an empty file travelled all the way to the API for a 400.
    if (size === 0) {
        throw Object.assign(
            new Error('Refusing to send a zero-byte file'),
            { statusCode: 400 },
        );
    }
    if (size > DISCORD_LIMITS.document) {
        throw Object.assign(
            new Error(`File exceeds Discord 10 MiB limit: ${(size / 1024 / 1024).toFixed(1)} MiB`),
            { statusCode: 413 },
        );
    }
}

export async function sendDiscordFile(
    client: Client,
    target: RemoteTarget,
    filePath: string,
    options?: { caption?: string; replyTo?: string; signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
    let fileStat;
    try {
        fileStat = await stat(filePath);
    } catch {
        return { ok: false, error: `File not found: ${filePath}` };
    }
    validateDiscordFileSize(filePath, fileStat.size);

    // Thread-aware: prefer threadId over targetId
    const resolvedId = target.threadId || target.targetId;
    // Cancellable REST first (#417): sendable.send() ignores AbortSignal, so a
    // shutdown could never abort the upload. The token lives on the client.
    if (client.token) {
        const rest = await sendDiscordFileRest(client.token, resolvedId, filePath,
            options?.caption, options?.signal ? { signal: options.signal } : {});
        return rest.ok ? { ok: true } : { ok: false, error: rest.error };
    }
    const channel = await client.channels.fetch(resolvedId);
    const sendable = asSendable(channel);
    if (!sendable) {
        return { ok: false, error: 'Target channel not text-based' };
    }

    try {
        await sendable.send({
            content: redactOutboundText(options?.caption || ''),
            files: [{ attachment: filePath, name: basename(filePath) }],
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `Discord file send failed: ${userErrorText(e)}` };
    }
}
