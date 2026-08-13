// Telegram-only approval keyboard (M4-A2b-tg).
// Discord/Slack stay text until they have a send API that can carry actions.
//
// callback_data is `appr:<uuid>` / `aprd:<uuid>` so it stays under Telegram's
// 64-byte limit and never embeds jti or digest.

import { dispatchApprovalStore, type DispatchApprovalRecord } from '../core/dispatch-approval.js';

const APPROVE_PREFIX = 'appr:';
const DENY_PREFIX = 'aprd:';

export type TelegramApprovalKeyboard = {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export type ApprovalPresentation = {
    text: string;
    telegramKeyboard: TelegramApprovalKeyboard | null;
};

export function parseApprovalCallbackData(data: string): { action: 'approve' | 'deny'; opaqueId: string } | null {
    if (data.startsWith(APPROVE_PREFIX)) return { action: 'approve', opaqueId: data.slice(APPROVE_PREFIX.length) };
    if (data.startsWith(DENY_PREFIX)) return { action: 'deny', opaqueId: data.slice(DENY_PREFIX.length) };
    return null;
}

export function presentTelegramApproval(
    record: DispatchApprovalRecord,
    operator: { actorId: string; conversationKey: string; sessionGeneration?: number },
    text: string,
): ApprovalPresentation {
    const sessionGeneration = operator.sessionGeneration ?? 0;
    const approveId = dispatchApprovalStore.issueApprovalCallback(record.jti, {
        actorId: operator.actorId,
        conversationKey: operator.conversationKey,
        sessionGeneration,
        action: 'approve',
    });
    const denyId = dispatchApprovalStore.issueApprovalCallback(record.jti, {
        actorId: operator.actorId,
        conversationKey: operator.conversationKey,
        sessionGeneration,
        action: 'deny',
    });
    if (!approveId || !denyId) return { text, telegramKeyboard: null };
    const approveData = APPROVE_PREFIX + approveId;
    const denyData = DENY_PREFIX + denyId;
    if (approveData.length > 64 || denyData.length > 64) return { text, telegramKeyboard: null };
    return {
        text,
        telegramKeyboard: {
            inline_keyboard: [[
                { text: 'Approve', callback_data: approveData },
                { text: 'Deny', callback_data: denyData },
            ]],
        },
    };
}
