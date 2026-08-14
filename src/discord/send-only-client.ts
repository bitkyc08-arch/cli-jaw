import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { settings } from '../core/config.js';
import { chunkDiscordMessage } from './forwarder.js';
import { validateDiscordFileSize } from './discord-file.js';
import { redactOutboundText } from '../messaging/redact.js';
import {
    DiscordRestScheduler,
    type DiscordRestResult,
} from './rest-scheduler.js';
import {
    discordDeliveryError,
    type DeliveryFailure,
} from '../messaging/delivery-outcome.js';

export type DiscordSendClientResult =
    | { token: string; reason?: never; status?: never }
    | { token: null; reason: string; status: 400 | 503 };

let cachedScheduler: { token: string; scheduler: DiscordRestScheduler } | null = null;

export function invalidateDiscordSendClient(): void {
    cachedScheduler?.scheduler.close();
    cachedScheduler = null;
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

export type DiscordRestSendResult =
    | { ok: true; failure?: never; error?: never; status?: never }
    | { ok: false; failure: DeliveryFailure; error: string; status?: number };

function schedulerFor(token: string): DiscordRestScheduler {
    if (cachedScheduler?.token === token) return cachedScheduler.scheduler;
    cachedScheduler?.scheduler.close();
    const scheduler = new DiscordRestScheduler({ token });
    cachedScheduler = { token, scheduler };
    return scheduler;
}

function sendResult<T>(result: DiscordRestResult<T>): DiscordRestSendResult {
    if (result.ok) return { ok: true };
    return {
        ok: false,
        failure: result.failure,
        error: result.failure.message,
        ...('status' in result && result.status !== undefined ? { status: result.status } : {}),
    };
}

export async function sendDiscordTextRest(
    token: string,
    channelId: string,
    text: string,
    extra?: { components?: unknown },
): Promise<DiscordRestSendResult> {
    const chunks = chunkDiscordMessage(text);
    for (const [index, chunk] of chunks.entries()) {
        const body: Record<string, unknown> = { content: chunk };
        if (index === 0 && extra?.components) body['components'] = extra.components;
        const result = await schedulerFor(token).schedule({
            method: 'POST',
            path: `/channels/${encodeURIComponent(channelId)}/messages`,
            routeKey: 'POST:/channels/:channel/messages',
            majorKey: channelId,
            makeInit: () => ({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            parse: async () => undefined,
        });
        if (!result.ok) return sendResult(result);
    }
    return { ok: true };
}

export async function openDiscordDm(token: string, userId: string, fetchImpl?: typeof fetch): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
    const scheduler = fetchImpl ? new DiscordRestScheduler({ token, fetchImpl }) : schedulerFor(token);
    const result = await scheduler.schedule<{ id?: string }>({
        method: 'POST',
        path: '/users/@me/channels',
        routeKey: 'POST:/users/@me/channels',
        majorKey: '@me',
        makeInit: () => ({
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: userId }),
        }),
        parse: response => response.json() as Promise<{ id?: string }>,
    });
    if (!result.ok || !result.value?.id) return { ok: false, error: result.ok ? 'discord_dm_channel_missing' : result.failure.message };
    return { ok: true, channelId: result.value.id };
}

export async function sendDiscordDm(
    token: string,
    userId: string,
    text: string,
    fetchImpl?: typeof fetch,
    extra?: { components?: unknown },
): Promise<DiscordRestSendResult> {
    const dm = await openDiscordDm(token, userId, fetchImpl);
    if (!dm.ok) return { ok: false, failure: discordDeliveryError({ channel: 'discord', message: dm.error, dispatched: false }), error: dm.error };
    if (!fetchImpl) return sendDiscordTextRest(token, dm.channelId, text, extra);
    const scheduler = new DiscordRestScheduler({ token, fetchImpl });
    const chunks = chunkDiscordMessage(text);
    for (const [index, chunk] of chunks.entries()) {
        const body: Record<string, unknown> = { content: chunk };
        if (index === 0 && extra?.components) body['components'] = extra.components;
        const result = await scheduler.schedule({ method: 'POST', path: `/channels/${encodeURIComponent(dm.channelId)}/messages`, routeKey: 'POST:/channels/:channel/messages', majorKey: dm.channelId, makeInit: () => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), parse: async () => undefined });
        if (!result.ok) return sendResult(result);
    }
    return { ok: true };
}

export async function sendDiscordFileRest(
    token: string,
    channelId: string,
    filePath: string,
    caption?: string,
): Promise<DiscordRestSendResult> {
    try {
        const buffer = await readFile(filePath);
        validateDiscordFileSize(filePath, buffer.length);
        const safeCaption = caption?.trim() ? redactOutboundText(caption.trim()) : '';
        const result = await schedulerFor(token).schedule({
            method: 'POST',
            path: `/channels/${encodeURIComponent(channelId)}/messages`,
            routeKey: 'POST:/channels/:channel/messages',
            majorKey: channelId,
            makeInit: () => {
                const form = new FormData();
                form.append('files[0]', new Blob([buffer]), basename(filePath));
                if (safeCaption) {
                    form.append('payload_json', JSON.stringify({ content: safeCaption }));
                }
                return { body: form };
            },
            parse: async () => undefined,
        });
        return sendResult(result);
    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        const failure = discordDeliveryError({
            channel: 'discord',
            ...(statusCode === undefined ? {} : { status: statusCode }),
            message: error instanceof Error ? error.message : String(error),
            dispatched: false,
            cause: error,
        });
        return {
            ok: false,
            failure,
            error: failure.message,
            ...(statusCode === undefined ? {} : { status: statusCode }),
        };
    }
}
