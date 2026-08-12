import {
    classifySendFailure,
    retryAfterMs,
    type SendFailureKind,
} from './retry.js';
import type { MessengerChannel } from './types.js';

export type DeliveryFailureKind =
    | SendFailureKind
    | 'auth'
    | 'permission'
    | 'not-found'
    | 'transient';

export interface DeliveryFailure {
    kind: DeliveryFailureKind;
    retryAfterMs: number;
    code?: string;
    message: string;
}

export interface DeliveryErrorInput {
    channel: MessengerChannel;
    status?: number;
    code?: string;
    message?: string;
    retryAfterMs?: number;
    /** True only when the transport proves it never dispatched the request. */
    dispatched?: boolean;
    cause?: unknown;
}

export type DeliveryErrorMapper = (err: unknown) => DeliveryFailure;

function errorInput(err: unknown, channel: MessengerChannel): DeliveryErrorInput {
    const record = err && typeof err === 'object'
        ? err as Record<string, unknown>
        : {};
    return {
        channel,
        ...(typeof record['status'] === 'number' ? { status: record['status'] } : {}),
        ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
        ...(typeof record['message'] === 'string' ? { message: record['message'] } : {}),
        ...(typeof record['retryAfterMs'] === 'number' ? { retryAfterMs: record['retryAfterMs'] } : {}),
        ...(typeof record['dispatched'] === 'boolean' ? { dispatched: record['dispatched'] } : {}),
        ...('cause' in record ? { cause: record['cause'] } : {}),
    };
}

function failure(kind: DeliveryFailureKind, input: DeliveryErrorInput): DeliveryFailure {
    const retry = Number.isFinite(input.retryAfterMs) && (input.retryAfterMs ?? 0) > 0
        ? Math.ceil(input.retryAfterMs!)
        : 0;
    return {
        kind,
        retryAfterMs: retry,
        ...(input.code ? { code: input.code } : {}),
        message: input.message || input.code || `Unknown ${input.channel} delivery failure`,
    };
}

export const telegramDeliveryError: DeliveryErrorMapper = (err) => {
    const kind = classifySendFailure(err);
    const record = err && typeof err === 'object'
        ? err as Record<string, unknown>
        : {};
    const message = String(record['description'] ?? record['message'] ?? err ?? 'Telegram send failed');
    return {
        kind,
        retryAfterMs: retryAfterMs(err),
        ...(record['error_code'] !== undefined ? { code: String(record['error_code']) } : {}),
        message,
    };
};

export const slackDeliveryError: DeliveryErrorMapper = (err) => {
    const input = errorInput(err, 'slack');
    const code = input.code;
    if (code === 'invalid_auth' || code === 'not_authed' || code === 'token_revoked'
        || code === 'account_inactive' || input.status === 401) return failure('auth', input);
    if (code === 'missing_scope' || code === 'not_in_channel' || input.status === 403) {
        return failure('permission', input);
    }
    if (code === 'channel_not_found' || code === 'is_archived' || input.status === 404) {
        return failure('not-found', input);
    }
    if (code === 'ratelimited' || input.status === 429) return failure('rate-limit', input);
    if (code === 'msg_too_long' || code === 'invalid_blocks' || code === 'invalid_arguments') {
        return failure('format', input);
    }
    return failure(input.dispatched === false ? 'transient' : 'ambiguous', input);
};

export const discordDeliveryError: DeliveryErrorMapper = (err) => {
    const input = errorInput(err, 'discord');
    if (input.status === 401) return failure('auth', input);
    if (input.status === 403) return failure('permission', input);
    if (input.status === 404) return failure('not-found', input);
    if (input.status === 429) return failure('rate-limit', input);
    if (input.status === 400 || input.status === 413) return failure('format', input);
    return failure(input.dispatched === false ? 'transient' : 'ambiguous', input);
};
