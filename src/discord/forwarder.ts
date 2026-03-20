// ─── Discord Forwarder ───────────────────────────────
// Forwards agent_done results to Discord channels.

import type { Client } from 'discord.js';
import type { RemoteTarget } from '../messaging/types.js';

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
    shouldSkip?: (data: Record<string, any>) => boolean;
    log?: (info: { channelId: string; preview: string }) => void;
    prefix?: string;
}) {
    return async (type: string, data: Record<string, any>) => {
        if (type !== 'agent_done' || !data?.text || data.error) return;
        if (opts.shouldSkip?.(data)) return;
        const target = opts.getLastTarget();
        if (!target?.targetId || !opts.client) return;
        try {
            const channel = await opts.client.channels.fetch(target.targetId);
            if (!channel || !('send' in channel)) return;
            const chunks = chunkDiscordMessage(`${opts.prefix || ''}${data.text}`);
            for (const chunk of chunks) {
                await (channel as any).send(chunk);
            }
            opts.log?.({ channelId: target.targetId, preview: data.text.slice(0, 60) });
        } catch (e) {
            console.error('[discord:forward]', (e as Error).message);
        }
    };
}
