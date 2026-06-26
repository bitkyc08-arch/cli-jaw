// Dashboard Telegram-hub CRUD routes (P1). Mounted at /api/dashboard/telegram-hub.
// Dashboard binds 127.0.0.1 → loopback-only by default. Token is never returned
// in plaintext (redact()); blank token on PUT keeps the stored token.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getHubConfig, setHubConfig, upsertRoute, removeRoute } from '../telegram-hub/routing-store.js';
import type { TelegramHubConfig, ThreadRoute } from '../telegram-hub/types.js';
import { MANAGED_INSTANCE_PORT_FROM, MANAGED_INSTANCE_PORT_TO } from '../constants.js';
import { startHubBot, sendToTopic } from '../telegram-hub/hub-bot.js';
import { assertSendFilePath } from '../../security/path-guards.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { settings } from '../../core/config.js';

const OUTBOUND_TYPES = new Set(['text', 'voice', 'photo', 'document']);

/** GPT Pro fix: hub routes (config CRUD + outbound send) are loopback-only, defense-in-depth
 *  beyond the dashboard's 127.0.0.1 bind. Trust the socket peer, never X-Forwarded-For. */
function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
    const ip = req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }
    res.status(403).json({ ok: false, error: 'loopback only' });
}

function redact(cfg: TelegramHubConfig): Omit<TelegramHubConfig, 'token'> & { token: string; hasToken: boolean } {
    return { ...cfg, token: '', hasToken: Boolean(cfg.token) };
}
function sendErr(res: Response, status: number, error: string): void {
    res.status(status).json({ ok: false, error });
}
function validPort(p: number): boolean {
    return Number.isInteger(p) && p >= MANAGED_INSTANCE_PORT_FROM && p <= MANAGED_INSTANCE_PORT_TO;
}

export function createDashboardTelegramHubRouter(): Router {
    const router = Router();
    router.use(loopbackOnly);

    router.get('/', (_req: Request, res: Response) => {
        res.json({ ok: true, config: redact(getHubConfig()) });
    });

    router.put('/', (req: Request, res: Response) => {
        const b = req.body || {};
        const patch: Partial<TelegramHubConfig> = {};
        if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
        if (typeof b.token === 'string' && b.token.trim()) patch.token = b.token.trim(); // empty ⇒ keep stored token
        if (typeof b.chatId === 'string') patch.chatId = b.chatId.trim();
        if (b.defaultPort != null) {
            if (!validPort(Number(b.defaultPort))) return sendErr(res, 400, 'defaultPort out of range');
            patch.defaultPort = Number(b.defaultPort);
        }
        const config = setHubConfig(patch);
        void startHubBot();   // apply enable/token/chatId changes to the running bot
        res.json({ ok: true, config: redact(config) });
    });

    router.post('/routes', (req: Request, res: Response) => {
        const b = req.body || {};
        const port = Number(b.port);
        if (typeof b.chatId !== 'string' || !b.chatId.trim()) return sendErr(res, 400, 'chatId required');
        if (typeof b.threadId !== 'string' || !b.threadId.trim()) return sendErr(res, 400, 'threadId required');
        if (!validPort(port)) return sendErr(res, 400, `port must be ${MANAGED_INSTANCE_PORT_FROM}-${MANAGED_INSTANCE_PORT_TO}`);
        const route: ThreadRoute = {
            chatId: b.chatId.trim(),
            threadId: b.threadId.trim(),
            port,
            ...(typeof b.label === 'string' && b.label.trim() ? { label: b.label.trim() } : {}),
            enabled: b.enabled !== false,
            // P4 per-topic overrides (optional)
            ...(typeof b.systemPrompt === 'string' && b.systemPrompt.trim() ? { systemPrompt: b.systemPrompt.trim() } : {}),
            ...(typeof b.model === 'string' && b.model.trim() ? { model: b.model.trim() } : {}),
        };
        res.json({ ok: true, config: redact(upsertRoute(route)) });
    });

    router.delete('/routes/:chatId/:threadId', (req: Request, res: Response) => {
        const chatId = String(req.params['chatId'] ?? '');
        const threadId = String(req.params['threadId'] ?? '');
        res.json({ ok: true, config: redact(removeRoute(chatId, threadId)) });
    });

    // Instance → hub outbound relay (P2). Loopback-only (router.use above); file paths
    // are validated against allowed roots (GPT Pro fix: no arbitrary-file exfiltration).
    router.post('/outbound', async (req: Request, res: Response) => {
        const b = req.body || {};
        const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
        const threadId = typeof b.threadId === 'string' ? b.threadId.trim() : '';
        if (!chatId || !threadId) return sendErr(res, 400, 'chatId+threadId required');
        // Defense-in-depth: outbound may only target the bound forum group (mirror of the
        // inbound bind-check), so a local process cannot relay to other chats the bot is in.
        if (chatId !== getHubConfig().chatId) return sendErr(res, 403, 'chatId is not the bound forum group');
        const type = String(b.type || 'text');
        if (!OUTBOUND_TYPES.has(type)) return sendErr(res, 400, 'invalid type');
        let filePath: string | undefined;
        if (type !== 'text') {
            if (typeof b.filePath !== 'string' || !b.filePath.trim()) return sendErr(res, 400, 'filePath required for file types');
            try {
                filePath = assertSendFilePath(b.filePath, settings["workingDir"] || undefined, settings["projectDirs"] || null);
            } catch {
                return sendErr(res, 403, 'filePath not allowed');
            }
        }
        const text = typeof b.text === 'string' ? b.text : undefined;
        const caption = typeof b.caption === 'string' ? b.caption.slice(0, 1024) : undefined;
        const r = await sendToTopic(chatId, threadId, stripUndefined({ type, text, filePath, caption }));
        res.status(r.ok ? 200 : 502).json(stripUndefined({ ok: r.ok, error: r.error }));
    });

    return router;
}
