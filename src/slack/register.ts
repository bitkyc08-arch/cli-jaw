// ─── Slack transport registrar (lazy) ────────────────
// Slack has no heavy SDK dependency (see 000_plan.md D-1), but the lazy shape
// mirrors src/discord/register.ts so every transport registers the same way and
// a disabled Slack never pulls its modules in.
//
// wp2 registers the SEND half only; registerTransport (inbound lifecycle)
// arrives in wp3 with bot.ts.

import { registerSendTransport } from '../messaging/send.js';
import type { ChannelSendRequest } from '../messaging/send.js';

registerSendTransport('slack', async (req: ChannelSendRequest) =>
    (await import('./send-handler.js')).slackSendHandler(req));
