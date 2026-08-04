// ─── Slack Slash Commands ────────────────────────────
// Payload shape: { command: '/jaw', text: '...', channel_id, channel_name,
//                  user_id, team_id, ... }
// Routed through the SHARED command pipeline (parseCommand/executeCommand),
// exactly like src/discord/commands.ts. The command catalog advertises
// commands on Slack, so forwarding raw text here instead would make that
// catalog a lie.
//
// Unlike Discord there is no deferReply/editReply: the socket layer owns the
// 3s ack, and every reply is posted asynchronously via chat.postMessage.

import { settings } from '../core/config.js';
import { getActiveChatSession, resolveOrCreateRemoteSession } from '../core/chat-sessions.js';
import { withSessionScope } from '../core/session-context.js';
import { log } from '../core/logger.js';
import { parseCommand, executeCommand } from '../cli/commands.js';
import { makeCommandCtx } from '../cli/command-context.js';
import { normalizeLocale } from '../core/i18n.js';
import { resetFallbackState } from '../agent/spawn.js';
import { applyRuntimeSettingsPatch } from '../core/runtime-settings.js';
import { bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { clearMainSessionState, resetSessionPreservingHistory } from '../core/main-session.js';
import { resetEmployeeSessions, seedDefaultEmployees } from '../core/employees.js';
import { slackTargetFromId } from '../messaging/slack-target.js';
import { buildRemoteBindingKey, type SessionScope } from '../messaging/session-key.js';
import { channelGateOn } from '../orchestrator/scope.js';
import { setLastActiveTarget } from '../messaging/runtime.js';
import { getSlackSendClient, sendSlackText } from './send-only-client.js';
import { isConversationAllowed } from './events.js';
import { logErrorText } from '../messaging/redact.js';

function makeSlackCommandCtx() {
    const locale = normalizeLocale(settings["locale"], 'ko');
    return makeCommandCtx('slack', locale, {
        applySettings: async (patch) => {
            bumpSessionOwnershipGeneration();
            return applyRuntimeSettingsPatch(patch, { resetFallbackState: () => resetFallbackState(null) });
        },
        clearSession: () => {
            bumpSessionOwnershipGeneration();
            clearMainSessionState();
        },
        resetSession: () => {
            bumpSessionOwnershipGeneration();
            resetSessionPreservingHistory();
        },
        resetEmployees: () => seedDefaultEmployees({ reset: true, notify: true }),
        resetEmployeeSessions: () => resetEmployeeSessions(),
    });
}

export async function handleSlackSlashCommand(payload: Record<string, unknown>): Promise<void> {
    const channelId = typeof payload['channel_id'] === 'string' ? payload['channel_id'] : '';
    const command = typeof payload['command'] === 'string' ? payload['command'] : '';
    const args = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
    if (!channelId || !command) return;

    // Same allowlist gate as the message path. Without this, a slash command
    // from a non-allowlisted channel reaches orchestration while an ordinary
    // message from the same channel is blocked.
    const configured = settings["slack"]?.channelIds;
    const channelIds = Array.isArray(configured) ? configured as string[] : [];
    const isDm = channelId.toUpperCase().startsWith('D')
        || payload['channel_name'] === 'directmessage';
    if (!isConversationAllowed(channelId, channelIds, isDm)) {
        log.info(`[slack:slash] blocked (channel_not_allowed) ${channelId}`);
        return;
    }

    const client = getSlackSendClient();
    if (!client.token) return;
    const token = client.token;
    const target = slackTargetFromId(channelId);
    const remoteKey = settings["multiSession"]?.enabled === true && channelGateOn('slack')
        ? buildRemoteBindingKey(target)
        : undefined;
    const chatSessionId = remoteKey ? resolveOrCreateRemoteSession(remoteKey) : getActiveChatSession();
    const scope = remoteKey || 'default';
    const sessionScope: SessionScope = { scope, chatSessionId };
    setLastActiveTarget('slack', target);

    // Slack delivers the command name and its arguments separately; the shared
    // parser expects one "/name args" string. parseCommand returns null only
    // for non-command text; an unrecognized NAME yields { type: 'unknown' },
    // which executeCommand handles with its suggestion/recovery path. Short-
    // circuiting here would bypass the UX Telegram and Discord already get.
    const parsed = parseCommand(`${command} ${args}`.trim());
    if (!parsed) {
        await sendSlackText(token, target, `Unrecognized input: ${command}`);
        return;
    }

    try {
        const result = await withSessionScope(sessionScope,
            () => executeCommand(parsed, makeSlackCommandCtx()));

        // /steer returns a prompt to run rather than text to print.
        if (result?.steerPrompt) {
            const steerPrompt = result.steerPrompt;
            if (result.text) await sendSlackText(token, target, result.text);
            const { orchestrateAndCollect } = await import('../orchestrator/collect.js');
            const reply = String(await withSessionScope(sessionScope, () => orchestrateAndCollect(steerPrompt, {
                origin: 'slack', target, chatId: channelId,
                ...(remoteKey ? { remoteKey } : {}), chatSessionId, scope, _skipInsert: true,
            })));
            await sendSlackText(token, target, reply);
            return;
        }

        await sendSlackText(token, target, result?.text || '(no output)');
    } catch (error) {
        log.error('[slack:slash]', logErrorText(error));
        await sendSlackText(token, target, `❌ ${(error as Error).message}`).catch(() => { });
    }
}
