// ─── Discord Forwarder ───────────────────────────────
// Forwards agent_done results to Discord channels.

import type { Client } from 'discord.js';
import { settings } from '../core/config.js';
import { log } from '../core/logger.js';
import { extractLocalImagePaths } from '../messaging/extract-images.js';
import type { RemoteTarget } from '../messaging/types.js';
import { chunkFenceAware } from '../messaging/chunk.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { asSendable } from './channel-types.js';
import { sendDiscordFile } from './discord-file.js';
import { redactOutboundText, logErrorText } from '../messaging/redact.js';

export async function relayDiscordImages(
    client: Client,
    target: RemoteTarget,
    text: string,
    options: { signal?: AbortSignal; skipPaths?: Set<string> } = {},
): Promise<void> {
    for (const candidate of extractLocalImagePaths(text)) {
        if (options.signal?.aborted) return;
        try {
            const filePath = assertSendFilePath(
                candidate,
                settings["workingDir"] || undefined,
                settings["projectDirs"] || null,
            );
            // Already uploaded by the agent itself during this turn. Relaying it
            // again would put the same picture in the channel twice.
            if (options.skipPaths?.has(filePath)) continue;
            const result = await sendDiscordFile(client, target, filePath,
                options.signal ? { signal: options.signal } : {});
            if (!result.ok) {
                log.warn('[discord:image-relay] send failed', {
                    path: candidate,
                    error: result.error || 'unknown error',
                });
            }
        } catch (error: unknown) {
            log.warn('[discord:image-relay] skipped', {
                path: candidate,
                error: logErrorText(error),
            });
        }
    }
}

/**
 * Split for Discord's 2,000-character message limit.
 *
 * Delegates to the shared splitter. The previous local implementation dropped
 * the newline it split on (`"aaa\nbbb"` came back as `["aaa", "bbb"]`), cut
 * mid-surrogate on a hard split, and ignored code fences entirely.
 *
 * Redaction happens here rather than at the six call sites. Every outbound
 * Discord text passes through this function, and masking per call site is how
 * the audit kept finding one that had been missed.
 */
/** Discord's hard per-message ceiling. Exported so the capability declaration is
 *  derived from the limit that actually chunks, not a second copy of the number. */
export const DISCORD_MESSAGE_LIMIT = 2000;

export function chunkDiscordMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
    return chunkFenceAware(redactOutboundText(text), limit);
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
            opts.log?.({ channelId: target.targetId, preview: redactOutboundText(text).slice(0, 60) });
        } catch (e) {
            log.error('[discord:forward]', logErrorText(e));
        }
    };
}
