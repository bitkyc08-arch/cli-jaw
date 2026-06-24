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
            console.error('[cmd:error]', err);
            const locale = resolveRequestLocale(req, req.body?.locale);
            res.status(500).json({
                ok: false,
                code: 'internal_error',
                text: t('api.serverError', { msg: (err as Error).message }, locale),
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

        // Slash command pre-processing: Telegram/Discord already do this,
        // but /api/message callers (REST, goal-continuation) bypass /api/command.
        if (trimmed.startsWith('/')) {
            const parsed = parseCommand(trimmed);
            if (parsed && (parsed.type === 'known' || parsed.type === 'skill' || parsed.type === 'unknown')) {
                try {
                    const locale = resolveRequestLocale(req);
                    const cmdResult = await executeCommand(parsed, makeWebCommandCtx(req, locale));
                    if (cmdResult?.steerPrompt) {
                        submitMessage(cmdResult.steerPrompt, { origin: 'web' });
                    }
                    res.json({ ok: true, command: true, ...cmdResult });
                    return;
                } catch (err: unknown) {
                    const error = (err as Error).message;
                    console.error('[api/message:cmd]', error);
                    res.status(500).json({ ok: false, command: true, error });
                    return;
                }
            }
        }

        const result = submitMessage(trimmed, { origin: 'web' });
        if (result.action === 'rejected') {
            const status = (result.reason === 'busy' || result.reason === 'duplicate') ? 409 : 400;
            res.status(status).json({ ok: false, error: result.reason, ...result });
            return;
        }
        res.json({ ok: true, ...result });
    });
}
