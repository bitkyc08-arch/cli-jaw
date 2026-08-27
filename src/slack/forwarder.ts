// ─── Slack Forwarder ─────────────────────────────────
// Forwards agent_done results to Slack conversations.
// Mirrors src/discord/forwarder.ts; no client object is needed because the
// Slack outbound path is stateless HTTP.

import { settings } from '../core/config.js';
import { log } from '../core/logger.js';
import { extractLocalImagePaths } from '../messaging/extract-images.js';
import type { RemoteTarget } from '../messaging/types.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { sendSlackFile } from './slack-file.js';
import { sendSlackText } from './send-only-client.js';
import { logErrorText } from '../messaging/redact.js';

export async function relaySlackImages(
    token: string,
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
            const result = await sendSlackFile(token, target, filePath,
                options.signal ? { signal: options.signal } : {});
            if (!result.ok) {
                log.warn('[slack:image-relay] send failed', {
                    path: candidate,
                    error: result.error || 'unknown error',
                });
            }
        } catch (error: unknown) {
            log.warn('[slack:image-relay] skipped', {
                path: candidate,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export function createSlackForwarder(opts: {
    getToken: () => string | null;
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
        const token = opts.getToken();
        if (!target?.targetId || !token) return;
        try {
            const result = await sendSlackText(token, target, `${opts.prefix || ''}${text}`);
            if (!result.ok) {
                log.error('[slack:forward]', logErrorText(result.error || 'send failed'));
                return;
            }
            await relaySlackImages(token, target, text);
            opts.log?.({ channelId: target.targetId, preview: text.slice(0, 60) });
        } catch (e) {
            log.error('[slack:forward]', logErrorText(e));
        }
    };
}
