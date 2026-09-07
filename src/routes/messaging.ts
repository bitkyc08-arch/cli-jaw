import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { httpStatus, httpCode, httpDetail } from './_http-error.js';
import fs from 'fs';
import os from 'os';
import { execFileSync, spawn } from 'node:child_process';
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
import { recordSelfDelivery } from '../messaging/turn-delivery.js';
import type { RemoteTarget } from '../messaging/types.js';

/**
 * The claim address for a send made through the legacy `/api/telegram/send`.
 *
 * It must agree field-for-field with what `buildTelegramTarget` produces on the
 * dispatch side, because the claim is keyed on the whole address: a key that
 * disagrees is the same as no claim at all, and the duplicate simply survives.
 *
 * `peerKind` is the one field this route cannot observe, having no `Context` to
 * read `chat.type` from. Telegram's own id convention settles it — group and
 * supergroup ids are negative, private chats positive — which is the same
 * distinction `isGroup` makes there. `threadId` follows the dispatch rule of
 * ignoring the General topic (id 1).
 */
function telegramTargetForClaim(chatId: string | number, threadId?: number): RemoteTarget {
    const targetId = String(chatId);
    return stripUndefined({
        channel: 'telegram',
        targetKind: 'channel',
        peerKind: targetId.startsWith('-') ? 'group' : 'direct',
        targetId,
        threadId: threadId !== undefined && threadId > 1 ? String(threadId) : undefined,
    }) as RemoteTarget;
}
import { validateChannelCredentials } from '../messaging/channel-validate.js';
import { sendResultHttpStatus } from '../messaging/send-result.js';
import { getSlackSendClient } from '../slack/send-only-client.js';
import { getSlackSelfUserId } from '../slack/bot.js';
import { fetchSlackHistory, fetchSlackReplies, formatHistoryForAgent } from '../slack/history.js';
import { getCachedSlackIdentities } from '../slack/identity.js';
import { fetchSlackChannelMembers, fetchSlackWorkspaceUsers, formatRosterForAgent } from '../slack/roster.js';
import type { SlackHistoryMessage } from '../slack/history.js';

/**
 * Best-effort author names for a history window. Every failure path yields an
 * empty map, which renders exactly as the pre-existing mention syntax.
 *
 * Cache-first by design: a 200-message window of unseen users must not turn into
 * a burst of users.info calls, and two concurrent history reads would each pace
 * themselves independently. Only names already resolved (by inbound traffic or a
 * roster read) are used here; unknown ids simply render as before.
 */
async function resolveHistoryNames(
    _token: string, messages: readonly SlackHistoryMessage[],
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const ids = new Set<string>();
    for (const message of messages) {
        if (message.user) ids.add(message.user);
        else if (message.botId) ids.add(message.botId);
    }
    if (!ids.size) return names;
    try {
        const teamId = String(settings["slack"]?.teamId || 'unknown');
        for (const [id, identity] of getCachedSlackIdentities(teamId, [...ids])) {
            if (identity.resolved) names.set(id, identity.name);
        }
    } catch {
        // Identity is decoration; a history read must never fail because of it.
    }
    return names;
}
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
    app.post('/api/file/open', requireAuth, async (req, res) => {
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
                // explorer.exe exits 1 even on success, so its exit code carries
                // no information and execFileSync would always throw (#383).
                // resolveOpenTarget already stat'ed the path, so a missing file
                // was rejected with 404 before any spawn. /select, and the path
                // must be ONE argv entry.
                const arg = target.strategy === 'reveal'
                    ? '/select,' + target.resolvedTarget
                    : target.openedPath;
                const child = spawn('explorer', [arg], { detached: true, stdio: 'ignore' });
                child.once('error', () => { /* explorer missing is not actionable here */ });
                child.unref();
            } else {
                // xdg-open may live as long as the desktop application (#540).
                // Acknowledge launch, not exit, without retaining server pipes.
                await new Promise<void>((resolve, reject) => {
                    const child = spawn('xdg-open', [target.openedPath], { detached: true, stdio: 'ignore' });
                    child.once('error', reject);
                    child.once('spawn', () => {
                        child.unref();
                        resolve();
                    });
                });
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
                // This legacy route is still advertised to agents, and it talks to
                // the Bot API directly instead of going through sendChannelOutput
                // — so it needs its own claim, or an answer delivered here would
                // be posted a second time when the turn settles.
                recordSelfDelivery({
                    target: telegramTargetForClaim(chatId, messageThreadId),
                    channel: 'telegram',
                    text,
                });
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
            // The FILE is never claimed: whether those bytes reached the user
            // cannot be proven from a path later (see messaging/turn-delivery.ts).
            // The caption is different — Telegram renders it as the message text
            // under the upload, so the user can see it, and an answer equal to it
            // would otherwise be posted a second time. Same rule the canonical
            // route follows for file sends.
            if (caption) {
                recordSelfDelivery({
                    target: telegramTargetForClaim(chatId, messageThreadId),
                    channel: 'telegram',
                    text: caption,
                });
            }
            res.json({ ok: true, chat_id: chatId, type, attempts: result.attempts });
        } catch (e: unknown) {
            log.error('[telegram:send]', logErrorText(e));
            const statusCode = httpStatus(e, 500);
            res.status(statusCode).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    // Onboarding wizard live credential check. Validates WITHOUT persisting —
    // the wizard saves through PUT /api/settings after this passes.
    app.post('/api/channels/validate', requireAuth, async (req, res) => {
        const result = await validateChannelCredentials(req.body || {});
        res.json(result.ok
            ? {
                ok: true,
                identity: result.identity,
                teamId: result.teamId,
                ...(result.missingCapabilities?.length
                    ? { missingCapabilities: result.missingCapabilities }
                    : {}),
            }
            : { ok: false, error: result.error, ...(result.missing?.length ? { missing: result.missing } : {}) });
    });

    // Canonical channel send
    app.post('/api/channel/send', requireAuth, async (req, res) => {
        try {
            // `fromAgentSurface` is set HERE rather than inside the normalizer:
            // it is a fact about how the send arrived, not about its body, and
            // an agent must not be able to claim it by putting a field in JSON.
            const result = await sendChannelOutput({
                ...normalizeChannelSendRequest(req.body),
                fromAgentSurface: true,
            });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[channel:send]', logErrorText(e));
            // The refusal reason alone left the caller nowhere to go: the allowed
            // roots live in settings an agent never reads (#404).
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    app.post('/api/discord/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput({
                ...normalizeChannelSendRequest(req.body),
                channel: 'discord',
                fromAgentSurface: true,
            });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[discord:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    app.post('/api/slack/send', requireAuth, async (req, res) => {
        try {
            const result = await sendChannelOutput({
                ...normalizeChannelSendRequest(req.body),
                channel: 'slack',
                fromAgentSurface: true,
            });
            if (!result.ok) {
                res.status(sendResultHttpStatus(result)).json(result);
                return;
            }
            res.json(result);
        } catch (e: unknown) {
            log.error('[slack:send]', logErrorText(e));
            res.status(httpStatus(e, 500)).json({
                error: userErrorText(e), code: httpCode(e),
                ...(httpDetail(e) ? { detail: httpDetail(e) } : {}),
            });
        }
    });

    // Dynamic Slack lookup for the agent: a channel window or one thread.
    // GET /api/slack/history?channel=C..[&thread_ts=..][&limit=..][&format=text]
    // Read-only and loopback-friendly (requireAuth bypasses localhost), so the
    // running agent can pull conversation context it was not mentioned into.
    app.get('/api/slack/history', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            // `!token` does not narrow the union (an empty string would land
            // here too), so default the status for the type system's sake.
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const channel = String(req.query['channel'] || '').trim();
        if (!channel) {
            res.status(400).json({ ok: false, error: 'channel_required' });
            return;
        }
        const threadTs = String(req.query['thread_ts'] || '').trim();
        const limit = Number(req.query['limit']) || undefined;
        const result = threadTs
            ? await fetchSlackReplies(client.token, channel, threadTs, { ...(limit ? { limit } : {}) })
            : await fetchSlackHistory(client.token, channel, { ...(limit ? { limit } : {}) });
        if (!result.ok) {
            // describeSlackError prose only (missing_scope names the scope);
            // never the raw upstream payload.
            res.status(502).json({ ok: false, error: result.error });
            return;
        }
        if (String(req.query['format'] || '') === 'text') {
            // Names are a best-effort garnish: if resolution is unavailable the map
            // is empty and the rendering falls back to raw mention syntax.
            const names = await resolveHistoryNames(client.token, result.messages);
            res.json({ ok: true, text: formatHistoryForAgent(result.messages, getSlackSelfUserId(), names) });
            return;
        }
        res.json({ ok: true, messages: result.messages, hasMore: result.hasMore });
    });

    // Who is in this conversation? Same contract shape as /api/slack/history:
    // read-only, loopback-friendly, prose errors only.
    // GET /api/slack/members?channel=C..[&limit=N][&format=text]
    app.get('/api/slack/members', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const channel = String(req.query['channel'] || '').trim();
        if (!channel) {
            res.status(400).json({ ok: false, error: 'channel_required' });
            return;
        }
        const limit = Number(req.query['limit']) || undefined;
        const result = await fetchSlackChannelMembers(client.token, channel, {
            teamId: String(settings["slack"]?.teamId || 'unknown'),
            ...(limit ? { limit } : {}),
        });
        if (!result.ok) {
            res.status(502).json({ ok: false, error: result.error });
            return;
        }
        if (String(req.query['format'] || '') === 'text') {
            res.json({ ok: true, text: formatRosterForAgent(result, { channel }) });
            return;
        }
        res.json({ ok: true, members: result.members, hasMore: result.hasMore, partial: result.partial });
    });

    // GET /api/slack/users[?limit=N][&include_bots=1][&include_deleted=1][&format=text]
    app.get('/api/slack/users', requireAuth, async (req, res) => {
        const client = getSlackSendClient();
        if (!client.token) {
            res.status(client.status ?? 503).json({ ok: false, error: client.reason ?? 'slack_unavailable' });
            return;
        }
        const limit = Number(req.query['limit']) || undefined;
        const result = await fetchSlackWorkspaceUsers(client.token, {
            teamId: String(settings["slack"]?.teamId || 'unknown'),
            ...(limit ? { limit } : {}),
            ...(req.query['include_bots'] ? { includeBots: true } : {}),
            ...(req.query['include_deleted'] ? { includeDeleted: true } : {}),
        });
        if (!result.ok) {
            res.status(502).json({ ok: false, error: result.error });
            return;
        }
        if (String(req.query['format'] || '') === 'text') {
            res.json({ ok: true, text: formatRosterForAgent(result) });
            return;
        }
        res.json({
            ok: true, members: result.members, hasMore: result.hasMore,
            partial: result.partial, ...(result.teamName ? { teamName: result.teamName } : {}),
        });
    });
}
