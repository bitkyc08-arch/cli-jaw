import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { httpStatus, httpCode } from './_http-error.js';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, normalize, resolve } from 'path';
import express from 'express';
import { ok, fail } from '../http/response.js';
import { saveUpload } from '../agent/spawn.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { getTelegramSendClient, getLatestTelegramChatId } from '../telegram/bot.js';
import { validateFileSize, sendTelegramFile } from '../telegram/telegram-file.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { decodeFilenameSafe } from '../security/decode.js';
import { sendChannelOutput, normalizeChannelSendRequest, validateExplicitChatId } from '../messaging/send.js';
import { sendResultHttpStatus } from '../messaging/send-result.js';
import { settings } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { log } from '../core/logger.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';

function resolveTelegramChatId(body: Record<string, unknown>): string | number | null {
    const raw = body?.['chat_id'] ?? body?.['chatId'];
    if (raw != null && String(raw).trim()) return raw as string | number;
    return getLatestTelegramChatId()
        ?? settings["telegram"]?.allowedChatIds?.[0]
        ?? null;
}

// ─── File open helpers ──────────────────────────────

const FILE_LINE_SUFFIX_RE = /^(.*?)(?::\d+(?::\d+)?)$/;
const DOCUMENT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.md', '.txt', '.yml', '.yaml',
    '.css', '.html', '.xml', '.svg',
    '.py', '.go', '.rs', '.java', '.sh',
    '.docx', '.xlsx', '.pptx', '.pdf',
]);

type OpenTarget = {
    openedPath: string;
    resolvedTarget: string;
    strategy: 'reveal' | 'folder' | 'directory';
};

function expandOpenPath(rawPath: string): string {
    return expandHomePath(rawPath, os.homedir());
}

function getExistingNormalizedPath(candidatePath: string): string | null {
    const normalized = normalize(resolve(candidatePath));
    return fs.existsSync(normalized) ? normalized : null;
}

function classifyOpenTarget(normalized: string): OpenTarget {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
        return { openedPath: normalized, resolvedTarget: normalized, strategy: 'directory' };
    }
    const ext = extname(normalized).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(ext)) {
        return { openedPath: normalized, resolvedTarget: normalized, strategy: 'reveal' };
    }
    return { openedPath: dirname(normalized), resolvedTarget: normalized, strategy: 'folder' };
}

function resolveOpenTarget(rawPath: string): OpenTarget {
    const expanded = expandOpenPath(rawPath);
    const exactMatch = getExistingNormalizedPath(expanded);
    if (exactMatch) return classifyOpenTarget(exactMatch);

    const strippedMatch = expanded.match(FILE_LINE_SUFFIX_RE)?.[1];
    if (strippedMatch) {
        const strippedPath = getExistingNormalizedPath(strippedMatch);
        if (strippedPath) return classifyOpenTarget(strippedPath);
    }

    throw new Error('file_not_found');
}

export function registerMessagingRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.post('/api/upload', requireAuth, express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
        try {
            const filename = decodeFilenameSafe(req.headers['x-filename'] as string | undefined);
            const filePath = saveUpload(req.body, filename);
            res.json({ path: filePath, filename: basename(filePath) });
        } catch (e: unknown) {
            res.status(httpStatus(e, 400)).json({ error: userErrorText(e) });
        }
    });

    // Open file in system file manager (Finder reveal)
    // NOTE: cli-jaw is a localhost-only program. No remote access.
    app.post('/api/file/open', requireAuth, (req, res) => {
        const { path: rawPath } = req.body;
        if (!rawPath || typeof rawPath !== 'string') {
            return fail(res, 400, 'path_required');
        }
        try {
            const target = resolveOpenTarget(rawPath);
            if (process.platform === 'darwin') {
                if (target.strategy === 'reveal') {
                    execFileSync('open', ['-R', target.resolvedTarget]);
                } else {
                    execFileSync('open', [target.openedPath]);
                }
            } else if (process.platform === 'win32') {
                if (target.strategy === 'reveal') {
                    execFileSync('explorer', ['/select,', target.resolvedTarget]);
                } else {
                    execFileSync('explorer', [target.openedPath]);
                }
            } else {
                execFileSync('xdg-open', [target.openedPath]);
            }
            ok(res, {
                opened: target.openedPath,
                resolvedTarget: target.resolvedTarget,
                strategy: target.strategy,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'open_failed';
            if (message === 'file_not_found') {
                return fail(res, 404, 'file_not_found');
            }
            fail(res, 500, 'open_failed');
        }
    });

    // Voice STT endpoint — receives raw audio blob, transcribes, submits as message
    app.post('/api/voice', requireAuth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }), async (req, res) => {
        try {
            const ext = (req.headers['x-voice-ext'] as string) || '.webm';
            const mime = req.headers['content-type'] || 'audio/webm';
            const filePath = saveUpload(req.body, `voice${ext}`);

            const { transcribeVoice } = await import('../../lib/stt.js');
            const result = await transcribeVoice(filePath, mime);

            if (!result.text.trim()) {
                res.status(422).json({ error: 'Empty transcription' });
                return;
            }

            log.info(`[web:voice] STT (${result.engine}, ${result.elapsed.toFixed(1)}s): ${redactOutboundText(result.text).slice(0, 80)}`);

            const sttOnly = String(req.headers['x-stt-only'] || '') === 'true';
            if (!sttOnly) {
                const prompt = `🎤 ${result.text}`;
                submitMessage(prompt, { origin: 'web' });
            }

            // A transcript is user-supplied text reflected back over HTTP.
            res.json({ ok: true, text: redactOutboundText(result.text), engine: result.engine, elapsed: result.elapsed });
        } catch (e: unknown) {
            log.error('[web:voice] STT failed:', logErrorText(e));
            res.status(500).json({ error: userErrorText(e) });
        }
    });

    // Telegram direct send
    app.post('/api/telegram/send', requireAuth, async (req, res) => {
        try {
            const sendClient = getTelegramSendClient();
            if (!sendClient.client) {
                res.status(sendClient.status ?? 503).json({ ok: false, error: sendClient.reason ?? 'Telegram not configured' });
                return;
            }

            const type = String(req.body?.type || '').trim().toLowerCase();
            const supportedTypes = new Set(['text', 'voice', 'photo', 'document']);
            if (!supportedTypes.has(type)) {
                res.status(400).json({ error: 'type must be one of: text, voice, photo, document' });
                return;
            }

            const chatId = resolveTelegramChatId(req.body || {});
            if (!chatId) {
                res.status(400).json({ error: 'chat_id required (or send a Telegram message first)' });
                return;
            }
            const explicitChatId = req.body?.chat_id ?? req.body?.chatId;
            if (explicitChatId != null && String(explicitChatId).trim() && !validateExplicitChatId('telegram', explicitChatId as string | number)) {
                res.status(403).json({ error: 'chat_id is not in the configured Telegram allowlist' });
                return;
            }

            // P0: optional message_thread_id (alias thread_id). General topic id=1 sends as
            // usual (n > 1), matching threadIdNumber + sendToTopic semantics.
            const rawThread = req.body?.message_thread_id ?? req.body?.thread_id;
            const threadNum = Number(rawThread);
            const messageThreadId = rawThread != null && Number.isInteger(threadNum) && threadNum > 1 ? threadNum : undefined;

            if (type === 'text') {
                const text = String(req.body?.text || '').trim();
                if (!text) {
                    res.status(400).json({ error: 'text required for type=text' });
                    return;
                }
                await sendClient.client.api.sendMessage(chatId, redactOutboundText(text), stripUndefined({ message_thread_id: messageThreadId }));
                res.json({ ok: true, chat_id: chatId, type });
                return;
            }

            const filePath = String(req.body?.file_path || '').trim();
            if (!filePath) {
                res.status(400).json({ error: 'file_path required for non-text types' });
                return;
            }
            const safePath = assertSendFilePath(filePath, settings["workingDir"] || undefined, settings["projectDirs"] || null);
            if (!fs.existsSync(safePath)) {
                res.status(400).json({ error: `file not found: ${safePath}` });
                return;
            }

            validateFileSize(safePath, type);

            const caption = req.body?.caption ? String(req.body.caption) : undefined;
            const result = await sendTelegramFile(sendClient.client, chatId, safePath, type, stripUndefined({ caption, threadId: messageThreadId }));

            if (!result.ok) {
                const sc = result.statusCode || 502;
                res.status(sc).json({
                    error: result.error, attempts: result.attempts,
                    ...(result.retryAfter != null && { retry_after: result.retryAfter }),
                });
                return;
            }
            res.json({ ok: true, chat_id: chatId, type, attempts: result.attempts });
        } catch (e: unknown) {
            log.error('[telegram:send]', logErrorText(e));
            const statusCode = httpStatus(e, 500);
            res.status(statusCode).json({ error: userErrorText(e), code: httpCode(e) });
        }
    });

    // Canonical channel send
    app.post('/api/channel/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput(normalizeChannelSendRequest(req.body));
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[channel:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({ error: userErrorText(e), code: httpCode(e) });
        }
    });

    app.post('/api/discord/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput({ ...normalizeChannelSendRequest(req.body), channel: 'discord' });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[discord:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({ error: userErrorText(e), code: httpCode(e) });
        }
    });

    app.post('/api/slack/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput({ ...normalizeChannelSendRequest(req.body), channel: 'slack' });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[slack:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({ error: userErrorText(e), code: httpCode(e) });
        }
    });
}
