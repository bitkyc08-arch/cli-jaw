import { parseActivityIdentity, type ActivityIdentity } from './presentation.js';

export const RUNTIME_REQUEST_NOTICE_EVENT = 'agent_runtime_requests_changed';

/** Transient wake-up: scope is presentation delivery, not an execution binding. */
export interface RuntimeRequestNotice extends ActivityIdentity { version: 1; }

export function parseRuntimeRequestNotice(value: unknown): RuntimeRequestNotice | null {
    const identity = parseActivityIdentity(value);
    if (!identity || (value as Record<string, unknown>)['version'] !== 1) return null;
    return { version: 1, ...identity };
}
