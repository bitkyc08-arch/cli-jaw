// ─── Discord Forwarder ───────────────────────────────
// Forwards agent_done results to Discord channels.

import type { Client } from 'discord.js';
import { settings } from '../core/config.js';
import { log } from '../core/logger.js';
import { extractLocalImagePaths } from '../messaging/extract-images.js';
import type { RemoteTarget } from '../messaging/types.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { asSendable } from './channel-types.js';
import { sendDiscordFile } from './discord-file.js';

export async function relayDiscordImages(
    client: Client,
    target: RemoteTarget,
    text: string,
): Promise<void> {
    for (const candidate of extractLocalImagePaths(text)) {
        try {
            const filePath = assertSendFilePath(
                candidate,
                settings["workingDir"] || undefined,
                settings["projectDirs"] || null,
            );
            const result = await sendDiscordFile(client, target, filePath);
            if (!result.ok) {
                log.warn('[discord:image-relay] send failed', {
                    path: candidate,
                    error: result.error || 'unknown error',
                });
            }
        } catch (error: unknown) {
            log.warn('[discord:image-relay] skipped', {
                path: candidate,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export function chunkDiscordMessage(text: string, limit = 2000): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) { chunks.push(remaining); break; }
        let cut = remaining.lastIndexOf('\n', limit);
        if (cut <= 0) cut = limit;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\n/, '');
    }
    return chunks;
}

export function createDiscordForwarder(opts: {
    client: Client;
    getLastTarget: () => RemoteTarget | null;
    shouldSkip?: (data: Record<string, unknown>) => boolean;
    log?: (info: { channelId: string; preview: string }) => void;
    prefix?: string;
}) {
    return async (type: string, data: Record<string, unknown>) => {
        const text = data?.["text"];
        if (type !== 'agent_done' || typeof text !== 'string' || !text || data["error"]) return;
        if (opts.shouldSkip?.(data)) return;
        const target = opts.getLastTarget();
        if (!target?.targetId || !opts.client) return;
        try {
            const channel = await opts.client.channels.fetch(target.targetId);
            const sendable = asSendable(channel);
            if (!sendable) return;
            const chunks = chunkDiscordMessage(`${opts.prefix || ''}${text}`);
            for (const chunk of chunks) {
                await sendable.send(chunk);
            }
            await relayDiscordImages(opts.client, target, text);
            opts.log?.({ channelId: target.targetId, preview: text.slice(0, 60) });
        } catch (e) {
            log.error('[discord:forward]', (e as Error).message);
        }
    };
}
