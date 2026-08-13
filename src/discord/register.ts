// ─── Discord transport registrar (lazy) ──────────────
// discord.js costs ~48MB RSS at import (260613 docs 07/51). The transport
// contract only needs these registrations at boot; the bot module — and
// discord.js with it — loads on first init/send. Instances with discord
// disabled never pay the import.

import { registerTransport } from '../messaging/runtime.js';
import { registerSendTransport } from '../messaging/send.js';
import type { ChannelSendRequest } from '../messaging/send.js';

registerTransport('discord', {
    init: async () => {
        await (await import('./bot.js')).initDiscord();
        return true;
    },
    shutdown: async () => (await import('./bot.js')).shutdownDiscord(),
});

registerSendTransport('discord', async (req: ChannelSendRequest) =>
    (await import('./bot.js')).discordSendHandler(req));
