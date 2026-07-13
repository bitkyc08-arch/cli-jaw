// 061 — capability probe client. Instance-scoped (/i/:port proxy) like the
// rest of the Code REST surface. Reasons are a bounded enum; the server never
// returns binary paths, tokens, or stderr.
export type CodeCapabilityReason = 'ok' | 'missing_binary' | 'acp_unsupported' | 'temporarily_unavailable';

export interface CodeCapabilityState {
    available: boolean;
    reason: CodeCapabilityReason;
    commandSource?: 'env' | 'package' | 'path';
    acpProtocolVersion?: number;
}

const KNOWN_REASONS = new Set<CodeCapabilityReason>(['ok', 'missing_binary', 'acp_unsupported', 'temporarily_unavailable']);

export async function fetchCodeCapabilities(
    port: number,
    opts: { refresh?: boolean } = {},
): Promise<CodeCapabilityState> {
    const suffix = opts.refresh ? '?refresh=1' : '';
    const response = await fetch(`/i/${port}/api/code/capabilities${suffix}`, {
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        // instance offline / route missing — retryable, never a hard error
        return { available: false, reason: 'temporarily_unavailable' };
    }
    const body = await response.json() as Record<string, unknown>;
    const reason = KNOWN_REASONS.has(body['reason'] as CodeCapabilityReason)
        ? body['reason'] as CodeCapabilityReason
        : 'temporarily_unavailable';
    return {
        available: body['available'] === true && reason === 'ok',
        reason,
        ...(body['commandSource'] === 'env' || body['commandSource'] === 'package' || body['commandSource'] === 'path'
            ? { commandSource: body['commandSource'] }
            : {}),
        ...(typeof body['acpProtocolVersion'] === 'number' ? { acpProtocolVersion: body['acpProtocolVersion'] } : {}),
    };
}
