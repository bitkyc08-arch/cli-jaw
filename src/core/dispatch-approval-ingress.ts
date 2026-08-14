import { dispatchApprovalStore, type ApprovalCallbackAction, type DispatchApprovalPlatform } from './dispatch-approval.js';
import { settings } from './config.js';
import { log } from './logger.js';
export type DispatchApprovalTransport = { readonly platform: DispatchApprovalPlatform };
const trustedTransports = new WeakSet<object>();

function createTransport(platform: DispatchApprovalPlatform, provenance: string): DispatchApprovalTransport {
    const transport = Object.freeze({ platform, provenance });
    trustedTransports.add(transport);
    return transport;
}

export function registerProductionTransport(transport: DispatchApprovalTransport): void {
    trustedTransports.add(transport as object);
}

export const createTestTransport = (platform: DispatchApprovalPlatform): DispatchApprovalTransport => {
    log.info(`[dispatch-approval:test-transport] platform=${platform}`);
    return createTransport(platform, 'test');
};

function isTrustedTransport(transport: DispatchApprovalTransport): boolean {
    return trustedTransports.has(transport as object);
}

function identity(transport: DispatchApprovalTransport, rawEvent: unknown): { senderId: string; bot: boolean; self: boolean } | null {
    const event = (rawEvent && typeof rawEvent === 'object' ? rawEvent : {}) as Record<string, unknown>;
    if (transport.platform === 'slack') {
        const user = event['user'];
        const senderId = typeof user === 'string'
            ? user
            : (user && typeof user === 'object' && 'id' in user ? String((user as { id: unknown }).id) : '');
        if (!senderId) return null;
        return {
            senderId,
            bot: Boolean(event['bot_id'] || event['subtype'] === 'bot_message'),
            self: Boolean(event['__jawSelf']),
        };
    }
    if (transport.platform === 'telegram') {
        const message = event['message'] as Record<string, unknown> | undefined;
        const from = (message?.['from'] ?? event['from']) as { id?: unknown; is_bot?: unknown } | undefined;
        return from?.id !== undefined ? { senderId: String(from.id), bot: Boolean(from.is_bot), self: Boolean(event['__jawSelf']) } : null;
    }
    const author = event['author'] as { id?: unknown; bot?: unknown } | undefined;
    return author?.id ? { senderId: String(author.id), bot: Boolean(author.bot), self: Boolean(event['__jawSelf']) } : null;
}

function allowed(platform: DispatchApprovalPlatform, senderId: string): boolean {
    const operators = settings["dispatchApproval"]?.operators;
    const list = Array.isArray(operators?.[platform]) ? operators[platform] : [];
    return list.some((value: unknown) => String(value) === senderId);
}

export function handleApprovalCommand(
    transport: DispatchApprovalTransport | null | undefined,
    rawEvent: unknown,
    text: string,
): { handled: boolean; approved?: boolean; reason?: string } {
    const match = /^\s*(approve|cancel|deny)\s+([0-9a-f-]{36})\s+([0-9a-f]{64})\s*$/i.exec(text);
    if (!match) return { handled: false };
    if (!transport || !isTrustedTransport(transport)) return { handled: true, approved: false, reason: 'untrusted_transport' };
    const actor = identity(transport, rawEvent);
    if (!actor) return { handled: true, approved: false, reason: 'missing_sender' };
    if (actor.bot || actor.self) return { handled: true, approved: false, reason: actor.self ? 'self' : 'bot' };
    if (!allowed(transport.platform, actor.senderId)) return { handled: true, approved: false, reason: 'operator_not_allowed' };
    const [, command, jti, digest] = match;
    if (command!.toLowerCase() === 'cancel' || command!.toLowerCase() === 'deny') {
        const cancelled = dispatchApprovalStore.cancel(jti!, digest!);
        return { handled: true, approved: false, reason: cancelled ? 'cancelled' : 'cancel_rejected' };
    }
    const consumed = dispatchApprovalStore.consume({ jti: jti!, digest: digest!, platform: transport.platform, senderId: actor.senderId });
    return { handled: true, approved: consumed.ok, ...(!consumed.ok ? { reason: consumed.reason } : {}) };
}

export function handleApprovalCallback(
    transport: DispatchApprovalTransport | null | undefined,
    rawEvent: unknown,
    opaqueId: string,
    action: ApprovalCallbackAction,
    presented: { conversationKey: string; sessionGeneration: number },
): { handled: true; approved?: boolean; reason?: string } {
    if (!transport || !isTrustedTransport(transport)) {
        return { handled: true, approved: false, reason: 'untrusted_transport' };
    }
    const actor = identity(transport, rawEvent);
    if (!actor) return { handled: true, approved: false, reason: 'missing_sender' };
    if (actor.bot || actor.self) return { handled: true, approved: false, reason: actor.self ? 'self' : 'bot' };
    if (!allowed(transport.platform, actor.senderId)) {
        return { handled: true, approved: false, reason: 'operator_not_allowed' };
    }
    const resolved = dispatchApprovalStore.resolveApprovalCallback(opaqueId, {
        actorId: actor.senderId,
        conversationKey: presented.conversationKey,
        sessionGeneration: presented.sessionGeneration,
        action,
    });
    if (!resolved.ok) return { handled: true, approved: false, reason: resolved.reason };
    if (action === 'deny') {
        const cancelled = dispatchApprovalStore.cancel(resolved.binding.jti, resolved.binding.digest);
        return { handled: true, approved: false, reason: cancelled ? 'cancelled' : 'cancel_rejected' };
    }
    const consumed = dispatchApprovalStore.consume({
        jti: resolved.binding.jti,
        digest: resolved.binding.digest,
        platform: transport.platform,
        senderId: actor.senderId,
    });
    return { handled: true, approved: consumed.ok, ...(!consumed.ok ? { reason: consumed.reason } : {}) };
}
