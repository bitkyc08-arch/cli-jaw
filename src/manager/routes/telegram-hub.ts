// Dashboard Telegram-hub CRUD routes (P1). Mounted at /api/dashboard/telegram-hub.
// Dashboard binds 127.0.0.1 → loopback-only by default. Token is never returned
// in plaintext (redact()); blank token on PUT keeps the stored token.
import { Router, type Request, type Response } from 'express';
import { getHubConfig, setHubConfig, upsertRoute, removeRoute } from '../telegram-hub/routing-store.js';
import type { TelegramHubConfig, ThreadRoute } from '../telegram-hub/types.js';
import { MANAGED_INSTANCE_PORT_FROM, MANAGED_INSTANCE_PORT_TO } from '../constants.js';

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
        res.json({ ok: true, config: redact(setHubConfig(patch)) });
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
        };
        res.json({ ok: true, config: redact(upsertRoute(route)) });
    });

    router.delete('/routes/:chatId/:threadId', (req: Request, res: Response) => {
        const chatId = String(req.params['chatId'] ?? '');
        const threadId = String(req.params['threadId'] ?? '');
        res.json({ ok: true, config: redact(removeRoute(chatId, threadId)) });
    });

    return router;
}
