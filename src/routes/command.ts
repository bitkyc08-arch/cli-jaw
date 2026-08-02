// ─── Command + message routes (web surface) ──────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.6).
// H17 /api/command, H18 /api/commands, H19 /api/message — tightly coupled via
// parseCommand/executeCommand/makeWebCommandCtx, kept in one module.

import type { Router, RequestHandler } from 'express';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { getVisibleCommands } from '../command-contract/policy.js';
import { makeWebCommandCtx } from '../cli/web-command-ctx.js';
import { resolveRequestLocale } from '../http/locale.js';
import { submitMessage } from '../orchestrator/gateway.js';
import { t } from '../core/i18n.js';
import { validateTarget } from '../messaging/send.js';
import { stripUndefined } from '../core/strip-undefined.js';
import type { RemoteTarget } from '../messaging/types.js';
import { log } from '../core/logger.js';
import { redactOutboundText, logErrorText, userErrorText } from '../messaging/redact.js';

/**
 * P2b: strict shape check for a hub-forwarded RemoteTarget on /api/message.
 * Must be a telegram channel target with a string targetId and (optional) string threadId.
 * Combined with validateTarget (allowlist) + requireAuth (loopback) before trusting it.
 */
export function isValidHubTarget(val: unknown): val is RemoteTarget {
    if (!val || typeof val !== 'object') return false;
    const o = val as Record<string, unknown>;
    if (o['channel'] !== 'telegram' || o['targetKind'] !== 'channel') return false;
    if (o['peerKind'] !== 'group' && o['peerKind'] !== 'direct') return false;
    if (typeof o['targetId'] !== 'string' || !o['targetId']) return false;
    if (o['threadId'] != null && typeof o['threadId'] !== 'string') return false;
    return true;
}

/** P4: sanitize per-topic model/systemPrompt overrides from a hub-forwarded request. */
export function sanitizeOverrides(val: unknown): { model?: string; systemPrompt?: string } | undefined {
    if (!val || typeof val !== 'object') return undefined;
    const o = val as Record<string, unknown>;
    const model = typeof o['model'] === 'string' && o['model'].trim() ? o['model'].trim() : undefined;
    const systemPrompt = typeof o['systemPrompt'] === 'string' && o['systemPrompt'].trim() ? o['systemPrompt'].trim() : undefined;
    if (!model && !systemPrompt) return undefined;
    return stripUndefined({ model, systemPrompt });
}

// Attachment-sized command text (SAC-004 contract — slash commands may carry
// inline attachment payloads, so the old 500-char truncation is forbidden).
const WEB_COMMAND_TEXT_LIMIT = 30_000;

export function registerCommandRoutes(app: Router, requireAuth: RequestHandler): void {
    app.post('/api/command', requireAuth, async (req, res) => {
        try {
            const text = String(req.body?.text || '').trim().slice(0, WEB_COMMAND_TEXT_LIMIT);
            const parsed = parseCommand(text);
            const locale = resolveRequestLocale(req, req.body?.locale);
            res.vary('Accept-Language');
            res.set('Content-Language', locale);
            if (!parsed) {
                res.status(400).json({
                    ok: false,
                    code: 'not_command',
                    text: t('api.notCommand', {}, locale),
                });
                return;
            }
            const result = await executeCommand(parsed, makeWebCommandCtx(req, locale as string));
            res.json(result);
        } catch (err: unknown) {
            log.error('[cmd:error]', logErrorText(err));
            const locale = resolveRequestLocale(req, req.body?.locale);
            res.status(500).json({
                ok: false,
                code: 'internal_error',
                text: t('api.serverError', { msg: userErrorText(err) }, locale),
            });
        }
    });

    app.get('/api/commands', (req, res) => {
        const iface = String(req.query["interface"] || 'web');
        const locale = resolveRequestLocale(req, req.query["locale"] as string);
        res.vary('Accept-Language');
        res.set('Content-Language', locale);
        const commands = getVisibleCommands(iface);
        res.json(commands
            .map(c => {
                const capability = (c as { capability?: Record<string, string> }).capability;
                return {
                    name: c.name,
                    desc: c.descKey ? t(c.descKey, {}, locale) : c.desc,
                    args: c.args || null,
                    category: c.category || 'tools',
                    aliases: c.aliases || [],
                    workflow: c.workflow || null,
                    capability: capability?.[iface] || null,
                };
            })
        );
    });

    app.post('/api/message', requireAuth, async (req, res) => {
        const prompt = req.body?.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            res.status(400).json({ error: 'prompt required' });
            return;
        }

        const trimmed = prompt.trim();

        // P2b: optional RemoteTarget when the hub forwards an inbound topic message.
        // Strict shape + allowlist validation; caller is loopback-trusted via requireAuth.
        const rawTarget = req.body?.target;
        if (rawTarget != null && (!isValidHubTarget(rawTarget) || !validateTarget(rawTarget, 'telegram'))) {
            res.status(400).json({ ok: false, error: 'invalid target' });
            return;
        }
        const target = (rawTarget ?? undefined) as RemoteTarget | undefined;
        // P4: per-topic overrides are only honored when the hub forwards a telegram target.
        const overrides = target ? sanitizeOverrides(req.body?.overrides) : undefined;
        // external: caller-declared "not the visible web chat input" marker
        // (manager relay, preview iframe relay, scripts). The web UI's SSE
        // new_message handler renders externally-injected user bubbles live
        // instead of waiting for a history reload (devlog 260705).
        const external = req.body?.external === true ? true : undefined;
        const submitMeta = stripUndefined({
            origin: target ? 'telegram' as const : 'web' as const,
            target,
            chatId: target?.targetId,
            overrides,
            replyViaTarget: Boolean(target),
            external,
        });

        // Slash command pre-processing: Telegram/Discord already do this,
        // but /api/message callers (REST, goal-continuation) bypass /api/command.
        if (trimmed.startsWith('/')) {
            const parsed = parseCommand(trimmed);
            if (parsed && (parsed.type === 'known' || parsed.type === 'skill' || parsed.type === 'unknown')) {
                try {
                    const locale = resolveRequestLocale(req);
                    const cmdResult = await executeCommand(parsed, makeWebCommandCtx(req, locale));
                    if (cmdResult?.steerPrompt) {
                        const submit = submitMessage(cmdResult.steerPrompt, submitMeta);
                        if (submit.action === 'rejected') {
                            const status = (submit.reason === 'busy' || submit.reason === 'duplicate') ? 409 : 400;
                            res.status(status).json({ ok: false, command: true, error: submit.reason, ...submit });
                            return;
                        }
                        res.json({ ok: true, command: true, ...cmdResult, submit });
                        return;
                    }
                    res.json({ ok: true, command: true, ...cmdResult });
                    return;
                } catch (err: unknown) {
                    log.error('[api/message:cmd]', logErrorText(err));
                    res.status(500).json({ ok: false, command: true, error: userErrorText(err) });
                    return;
                }
            }
        }

        const result = submitMessage(trimmed, submitMeta);
        if (result.action === 'rejected') {
            const status = (result.reason === 'busy' || result.reason === 'duplicate') ? 409 : 400;
            res.status(status).json({ ok: false, error: result.reason, ...result });
            return;
        }
        res.json({ ok: true, ...result });
    });

    // Hub elicitation callback relay: hub forwards elic:Q:O taps to the instance.
    app.post('/api/elicitation/callback', requireAuth, async (req, res) => {
        const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : '';
        const callbackData = typeof req.body?.callbackData === 'string' ? req.body.callbackData : '';
        if (!chatId || !callbackData) {
            res.status(400).json({ ok: false, error: 'chatId and callbackData required' });
            return;
        }
        const { handleElicitationCallback } = await import('../telegram/elicitation-buttons.js');
        const result = handleElicitationCallback(chatId, callbackData);
        if (result.kind === 'complete') {
            const target = req.body?.target;
            const submit = submitMessage(result.combinedAnswer, stripUndefined({
                origin: 'telegram' as const,
                target,
                chatId,
                replyViaTarget: Boolean(target),
            }));
            res.json({ ok: true, kind: 'complete', ack: redactOutboundText(result.ack), submit });
            return;
        }
        res.json({
            ok: true,
            kind: result.kind,
            ack: result.kind === 'progress' ? redactOutboundText(result.ack) : undefined,
        });
    });
}
