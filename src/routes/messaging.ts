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
import { telegramBot, telegramActiveChatIds } from '../telegram/bot.js';
import { validateFileSize, sendTelegramFile } from '../telegram/telegram-file.js';
import { assertSendFilePath } from '../security/path-guards.js';
import { decodeFilenameSafe } from '../security/decode.js';
import { sendChannelOutput, normalizeChannelSendRequest } from '../messaging/send.js';
import { settings } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';

function getLatestTelegramChatId() {
    const ids = Array.from(telegramActiveChatIds);
    return ids.at(-1) || null;
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
            res.status(httpStatus(e, 400)).json({ error: (e as Error).message });
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
                return res.status(422).json({ error: 'Empty transcription' });
            }

            console.log(`[web:voice] STT (${result.engine}, ${result.elapsed.toFixed(1)}s): ${result.text.slice(0, 80)}`);

            const sttOnly = String(req.headers['x-stt-only'] || '') === 'true';
            if (!sttOnly) {
                const prompt = `🎤 ${result.text}`;
                submitMessage(prompt, { origin: 'web' });
            }

            res.json({ ok: true, text: result.text, engine: result.engine, elapsed: result.elapsed });
        } catch (e: unknown) {
            console.error('[web:voice] STT failed:', (e as Error).message);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    // Telegram direct send
    app.post('/api/telegram/send', requireAuth, async (req, res) => {
        try {
            if (!telegramBot) return res.status(503).json({ error: 'Telegram not connected' });

            const type = String(req.body?.type || '').trim().toLowerCase();
            const supportedTypes = new Set(['text', 'voice', 'photo', 'document']);
            if (!supportedTypes.has(type)) {
                return res.status(400).json({ error: 'type must be one of: text, voice, photo, document' });
            }

            const chatId = req.body?.chat_id || getLatestTelegramChatId();
            if (!chatId) return res.status(400).json({ error: 'chat_id required (or send a Telegram message first)' });

            if (type === 'text') {
                const text = String(req.body?.text || '').trim();
                if (!text) return res.status(400).json({ error: 'text required for type=text' });
                await telegramBot.api.sendMessage(chatId, text);
                return res.json({ ok: true, chat_id: chatId, type });
            }

            const filePath = String(req.body?.file_path || '').trim();
            if (!filePath) return res.status(400).json({ error: 'file_path required for non-text types' });
            const safePath = assertSendFilePath(filePath, settings.workingDir || undefined);
            if (!fs.existsSync(safePath)) return res.status(400).json({ error: `file not found: ${safePath}` });

            validateFileSize(safePath, type);

            const caption = req.body?.caption ? String(req.body.caption) : undefined;
            const result = await sendTelegramFile(telegramBot, chatId, safePath, type, { caption });

            if (!result.ok) {
                const sc = result.statusCode || 502;
                return res.status(sc).json({
                    error: result.error, attempts: result.attempts,
                    ...(result.retryAfter != null && { retry_after: result.retryAfter }),
                });
            }
            return res.json({ ok: true, chat_id: chatId, type, attempts: result.attempts });
        } catch (e: unknown) {
            console.error('[telegram:send]', e);
            const statusCode = httpStatus(e, 500);
            return res.status(statusCode).json({ error: (e as Error).message, code: httpCode(e) });
        }
    });

    // Canonical channel send
    app.post('/api/channel/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput(normalizeChannelSendRequest(req.body));
            if (!result.ok) return res.status(502).json(result);
            return res.json(result);
        } catch (e: unknown) {
            console.error('[channel:send]', e);
            return res.status(500).json({ error: (e as Error).message });
        }
    });

    app.post('/api/discord/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput({ ...normalizeChannelSendRequest(req.body), channel: 'discord' });
            if (!result.ok) return res.status(502).json(result);
            return res.json(result);
        } catch (e: unknown) {
            console.error('[discord:send]', e);
            return res.status(500).json({ error: (e as Error).message });
        }
    });
}
