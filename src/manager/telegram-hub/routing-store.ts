// Telegram hub routing store (P1) — thin CRUD over the Dashboard registry's
// telegramHub config. P2 (hub bot) consumes getHubConfig/resolveRoute.
import { loadDashboardRegistry, patchDashboardRegistry } from '../registry.js';
import type { TelegramHubConfig, ThreadRoute } from './types.js';

export function getHubConfig(): TelegramHubConfig {
    return loadDashboardRegistry().registry.telegramHub;
}

export function setHubConfig(patch: Partial<TelegramHubConfig>): TelegramHubConfig {
    return patchDashboardRegistry({ telegramHub: patch }).registry.telegramHub;
}

export function upsertRoute(route: ThreadRoute): TelegramHubConfig {
    const cfg = getHubConfig();
    const routes = cfg.routes.filter(r => !(r.chatId === route.chatId && r.threadId === route.threadId));
    routes.push(route);
    return setHubConfig({ routes });
}

export function removeRoute(chatId: string, threadId: string): TelegramHubConfig {
    const routes = getHubConfig().routes.filter(r => !(r.chatId === chatId && r.threadId === threadId));
    return setHubConfig({ routes });
}

/** Active route for an inbound topic, or undefined (P2 refuses unmapped topics — no defaultPort auto-route). */
export function resolveRoute(chatId: string, threadId: string): ThreadRoute | undefined {
    return getHubConfig().routes.find(r => r.chatId === chatId && r.threadId === threadId && r.enabled);
}
