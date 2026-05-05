import { InputFile, type Bot } from 'grammy';
import fs from 'node:fs';
import { stripUndefined } from '../core/strip-undefined.js';

interface TelegramApiErrorLike {
    error_code?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    parameters?: { retry_after?: number };
    constructor?: { name?: string };
}

function asTgErr(err: unknown): TelegramApiErrorLike {
    return (err && typeof err === 'object') ? (err as TelegramApiErrorLike) : {};
}

// Telegram Bot API file size limits (bytes)
// https://core.telegram.org/bots/api#sendphoto / #senddocument / #sendvoice
export const TELEGRAM_LIMITS: Record<string, number> = {
    document: 50 * 1024 * 1024,   // 50 MB
    photo: 10 * 1024 * 1024,   // 10 MB
    voice: 50 * 1024 * 1024,   // 50 MB
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;       // single retry delay cap
const MAX_TOTAL_WAIT_MS = 60_000;  // cumulative wait cap

/**
 * Pre-validate file size against Telegram limits.
 * Throws with descriptive message if exceeded.
 */
export function validateFileSize(filePath: string, type: string): void {
    const limit = TELEGRAM_LIMITS[type];
    if (!limit) return;
    const stat = fs.statSync(filePath);
    if (stat.size > limit) {
        const limitMB = (limit / 1024 / 1024).toFixed(0);
        const actualMB = (stat.size / 1024 / 1024).toFixed(1);
        throw Object.assign(
            new Error(`File too large for Telegram ${type}: ${actualMB}MB (limit: ${limitMB}MB)`),
            { code: 'FILE_TOO_LARGE', statusCode: 400 },
        );
    }
}

/** Classify error as transient (retryable) using grammY error types. */
function isTransient(err: unknown): boolean {
    const e = asTgErr(err);
    if (typeof e.error_code === 'number') {
        if (e.error_code === 429) return true;
        if (e.error_code >= 500) return true;
        return false;
    }
    if (e.constructor?.name === 'HttpError') return true;
    const code = e.code || '';
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/.test(code)) return true;
    return false;
}

function getRetryAfterMs(err: unknown): number {
    return (asTgErr(err).parameters?.retry_after ?? 0) * 1000;
}

/** Determine upstream error category for HTTP response code. */
export function classifyUpstreamError(err: unknown): number {
    const e = asTgErr(err);
    if (e.error_code === 429) return 429;
    return 502; // 5xx or network
}

/**
 * Send a file to Telegram with exponential backoff retry.
 * Creates a fresh InputFile per attempt (stream safety).
 */
export async function sendTelegramFile(
    bot: Bot,
    chatId: number | string,
    filePath: string,
    type: string,
    opts?: { caption?: string },
): Promise<{ ok: boolean; attempts: number; error?: string; retryAfter?: number; statusCode?: number }> {
    const caption = opts?.caption;
    let totalWaited = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const file = new InputFile(filePath);
            switch (type) {
                case 'voice':
                    await bot.api.sendVoice(chatId, file, stripUndefined({ caption }));
                    break;
                case 'photo':
                    await bot.api.sendPhoto(chatId, file, stripUndefined({ caption }));
                    break;
                case 'document':
                    await bot.api.sendDocument(chatId, file, stripUndefined({ caption }));
                    break;
                default:
                    return { ok: false, attempts: attempt, error: `unsupported type: ${type}`, statusCode: 400 };
            }
            return { ok: true, attempts: attempt };
        } catch (err: unknown) {
            const e = asTgErr(err);
            const transient = isTransient(err);
            if (!transient || attempt === MAX_RETRIES) {
                const sc = transient ? classifyUpstreamError(err) : (e.error_code || e.statusCode || 500);
                console.error(`[telegram:file] failed after ${attempt} attempt(s):`, e.message);
                return stripUndefined({
                    ok: false, attempts: attempt,
                    error: e.message || 'unknown error',
                    retryAfter: e.error_code === 429 ? e.parameters?.retry_after : undefined,
                    statusCode: sc,
                });
            }

            const retryAfterMs = getRetryAfterMs(err);
            // If upstream demands more than MAX_DELAY_MS, bail immediately
            if (retryAfterMs > MAX_DELAY_MS) {
                console.error(`[telegram:file] retry_after ${retryAfterMs}ms exceeds cap, giving up`);
                return stripUndefined({
                    ok: false, attempts: attempt,
                    error: `retry_after too large: ${retryAfterMs}ms`,
                    retryAfter: e.parameters?.retry_after,
                    statusCode: 429,
                });
            }

            const delay = Math.max(retryAfterMs, BASE_DELAY_MS * Math.pow(2, attempt - 1));
            totalWaited += delay;
            if (totalWaited >= MAX_TOTAL_WAIT_MS) {
                console.error(`[telegram:file] total wait ${totalWaited}ms exceeds cap, giving up`);
                return {
                    ok: false, attempts: attempt,
                    error: `total retry wait exceeded ${MAX_TOTAL_WAIT_MS}ms`,
                    statusCode: classifyUpstreamError(err),
                };
            }

            console.warn(`[telegram:retry] attempt ${attempt}/${MAX_RETRIES} failed (${e.error_code || 'network'}), retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return { ok: false, attempts: MAX_RETRIES, error: 'exhausted retries', statusCode: 502 };
}
