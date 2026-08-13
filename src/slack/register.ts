// ─── Slack transport registrar (lazy) ────────────────
// Slack has no heavy SDK dependency (see 000_plan.md D-1), but the lazy shape
// mirrors src/discord/register.ts so every transport registers the same way and
// a disabled Slack never pulls its modules in.
//
import { registerTransport } from '../messaging/runtime.js';
import { registerSendTransport } from '../messaging/send.js';
import type { ChannelSendRequest } from '../messaging/send.js';

registerTransport('slack', {
    init: async () => (await import('./bot.js')).initSlack(),
    shutdown: async () => (await import('./bot.js')).shutdownSlack(),
});

registerSendTransport('slack', async (req: ChannelSendRequest) =>
    (await import('./send-handler.js')).slackSendHandler(req));
