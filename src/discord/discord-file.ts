// ─── Discord File Send ───────────────────────────────
// Outbound file delivery for Discord. 10 MiB cap per create-message.

import type { Client } from 'discord.js';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RemoteTarget } from '../messaging/types.js';

export const DISCORD_LIMITS = {
    document: 10 * 1024 * 1024,
    photo: 10 * 1024 * 1024,
    voice: 10 * 1024 * 1024,
};

export function validateDiscordFileSize(filePath: string, size: number) {
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
    options?: { caption?: string; replyTo?: string },
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
    const channel = await client.channels.fetch(resolvedId);
    if (!channel || !('send' in channel)) {
        return { ok: false, error: 'Target channel not text-based' };
    }

    try {
        await (channel as any).send({
            content: options?.caption || '',
            files: [{ attachment: filePath, name: basename(filePath) }],
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `Discord file send failed: ${(e as Error).message}` };
    }
}
