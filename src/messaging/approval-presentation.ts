// Approval keyboards for operator DMs.
// Telegram: inline keyboard callback_data `appr:<uuid>` / `aprd:<uuid>` (64-byte cap).
// Discord: action-row buttons with the same custom_id prefix (100-byte cap).
// Slack operator DMs: Block Kit actions with the same action_id prefix.
// Generic ChannelSendRequest keyboard is still unsupported.
//
// Ids never embed jti or digest.

import { dispatchApprovalStore, type DispatchApprovalRecord } from '../core/dispatch-approval.js';

const APPROVE_PREFIX = 'appr:';
const DENY_PREFIX = 'aprd:';

export type TelegramApprovalKeyboard = {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export type DiscordApprovalComponents = Array<{
    type: 1;
    components: Array<{ type: 2; style: 3 | 4; custom_id: string; label: string }>;
}>;

export type SlackApprovalBlocks = Array<{
    type: 'actions';
    elements: Array<{ type: 'button'; text: { type: 'plain_text'; text: string }; action_id: string; style?: 'primary' | 'danger' }>;
}>;

export type ApprovalPresentation = {
    text: string;
    telegramKeyboard: TelegramApprovalKeyboard | null;
    discordComponents: DiscordApprovalComponents | null;
    slackBlocks: SlackApprovalBlocks | null;
};

export function parseApprovalCallbackData(data: string): { action: 'approve' | 'deny'; opaqueId: string } | null {
    if (data.startsWith(APPROVE_PREFIX)) return { action: 'approve', opaqueId: data.slice(APPROVE_PREFIX.length) };
    if (data.startsWith(DENY_PREFIX)) return { action: 'deny', opaqueId: data.slice(DENY_PREFIX.length) };
    return null;
}

function issuePair(
    record: DispatchApprovalRecord,
    operator: { actorId: string; conversationKey: string; sessionGeneration?: number },
): { approveData: string; denyData: string } | null {
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
    if (!approveId || !denyId) return null;
    return { approveData: APPROVE_PREFIX + approveId, denyData: DENY_PREFIX + denyId };
}

export function presentTelegramApproval(
    record: DispatchApprovalRecord,
    operator: { actorId: string; conversationKey: string; sessionGeneration?: number },
    text: string,
): ApprovalPresentation {
    const pair = issuePair(record, operator);
    if (!pair || pair.approveData.length > 64 || pair.denyData.length > 64) {
        return { text, telegramKeyboard: null, discordComponents: null, slackBlocks: null };
    }
    return {
        text,
        telegramKeyboard: {
            inline_keyboard: [[
                { text: 'Approve', callback_data: pair.approveData },
                { text: 'Deny', callback_data: pair.denyData },
            ]],
        },
        discordComponents: null,
        slackBlocks: null,
    };
}

export function presentDiscordApproval(
    record: DispatchApprovalRecord,
    operator: { actorId: string; conversationKey: string; sessionGeneration?: number },
    text: string,
): ApprovalPresentation {
    const pair = issuePair(record, operator);
    if (!pair || pair.approveData.length > 100 || pair.denyData.length > 100) {
        return { text, telegramKeyboard: null, discordComponents: null, slackBlocks: null };
    }
    return {
        text,
        telegramKeyboard: null,
        discordComponents: [{
            type: 1,
            components: [
                { type: 2, style: 3, custom_id: pair.approveData, label: 'Approve' },
                { type: 2, style: 4, custom_id: pair.denyData, label: 'Deny' },
            ],
        }],
        slackBlocks: null,
    };
}

export function presentSlackApproval(
    record: DispatchApprovalRecord,
    operator: { actorId: string; conversationKey: string; sessionGeneration?: number },
    text: string,
): ApprovalPresentation {
    const pair = issuePair(record, operator);
    if (!pair || pair.approveData.length > 255 || pair.denyData.length > 255) {
        return { text, telegramKeyboard: null, discordComponents: null, slackBlocks: null };
    }
    return {
        text,
        telegramKeyboard: null,
        discordComponents: null,
        slackBlocks: [{
            type: 'actions',
            elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: pair.approveData, style: 'primary' },
                { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: pair.denyData, style: 'danger' },
            ],
        }],
    };
}
