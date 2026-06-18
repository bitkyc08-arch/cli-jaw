import type { CodeSessionClient } from './code-session-client';
import {
    permissionAuditEntry,
    resolvePermissionOption,
    type PendingPermission,
    type PermissionMode,
    type PermissionOptionKind,
    type TranscriptEntry,
} from './code-types';

type PermissionFlowSink = {
    appendMessage: (entry: TranscriptEntry) => void;
    enqueuePermission: (permission: PendingPermission) => void;
};

type PermissionFlowClient = Pick<CodeSessionClient, 'answerPermission'>;

export function handleIncomingPermissionRequest(
    client: PermissionFlowClient,
    permissionMode: PermissionMode,
    permission: PendingPermission,
    sink: PermissionFlowSink,
): void {
    sink.appendMessage(permissionAuditEntry(permission, {
        mode: permissionMode,
        decision: 'pending',
        decisionMode: permissionMode === 'ask' ? 'pending' : 'automatic',
    }));
    if (permissionMode === 'ask') {
        sink.enqueuePermission(permission);
        return;
    }

    const targetKind: PermissionOptionKind = permissionMode === 'always-allow' ? 'allow_always' : 'reject_always';
    const option = resolvePermissionOption(permission.options, targetKind);
    if (!option) {
        sink.appendMessage(permissionAuditEntry(permission, {
            mode: permissionMode,
            decision: 'missing_option',
            decisionMode: 'system',
            error: `${targetKind} was not provided by JWC for this request.`,
        }));
        sink.enqueuePermission(permission);
        return;
    }

    void (async () => {
        try {
            await client.answerPermission(permission.permissionId, option.optionId);
            sink.appendMessage(permissionAuditEntry(permission, {
                mode: permissionMode,
                decision: targetKind,
                decisionMode: 'automatic',
                optionId: option.optionId,
                optionLabel: option.label,
            }));
        } catch (err) {
            sink.appendMessage(permissionAuditEntry(permission, {
                mode: permissionMode,
                decision: 'answer_error',
                decisionMode: 'system',
                optionId: option.optionId,
                optionLabel: option.label,
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    })();
}

export async function answerQueuedPermission(
    client: PermissionFlowClient,
    permissionMode: PermissionMode,
    permission: PendingPermission,
    action: PermissionOptionKind,
    appendMessage: (entry: TranscriptEntry) => void,
): Promise<boolean> {
    const option = resolvePermissionOption(permission.options, action);
    if (!option) {
        appendMessage(permissionAuditEntry(permission, {
            mode: permissionMode,
            decision: 'missing_option',
            decisionMode: 'system',
            error: `${action} was not provided by JWC for this request.`,
        }));
        return false;
    }
    try {
        await client.answerPermission(permission.permissionId, option.optionId);
        appendMessage(permissionAuditEntry(permission, {
            mode: permissionMode,
            decision: action,
            decisionMode: 'manual',
            optionId: option.optionId,
            optionLabel: option.label,
        }));
    } catch (err) {
        appendMessage(permissionAuditEntry(permission, {
            mode: permissionMode,
            decision: 'answer_error',
            decisionMode: 'system',
            optionId: option.optionId,
            optionLabel: option.label,
            error: err instanceof Error ? err.message : String(err),
        }));
    }
    return true;
}
