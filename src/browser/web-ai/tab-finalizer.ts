import { updateSessionResult } from './session.js';
import { poolTab } from './tab-pool.js';
import type { WebAiSessionRecord, WebAiVendor } from './types.js';

export interface FinalizeProviderTabInput {
    vendor: WebAiVendor;
    session: WebAiSessionRecord;
    port: number;
    url: string;
    answerText: string;
    owner?: string;
    sessionType?: string;
    /**
     * parity2 040 slice 4.3 (C-06): re-checked before EVERY side-effect phase,
     * not once at entry. Each phase can block long enough for the caller's
     * deadline to pass inside it; a losing run must not write the answer or
     * pool the tab after its caller was already handed a timeout.
     */
    stillActive?: () => boolean;
}

export interface FinalizeProviderTabResult {
    finalized: boolean;
    skippedReason?: 'poll-deadline-exceeded';
    pooled?: boolean;
}

export async function finalizeProviderTab(input: FinalizeProviderTabInput): Promise<FinalizeProviderTabResult> {
    const expired = () => input.stillActive?.() === false;
    if (expired()) return { finalized: false, skippedReason: 'poll-deadline-exceeded' };
    updateSessionResult({
        sessionId: input.session.sessionId,
        status: 'complete',
        url: input.url,
        conversationUrl: input.url,
        answerText: input.answerText,
    });
    // Re-checked AFTER the session write: the store lock can retry long enough
    // for a deadline to pass inside it, and pooling then would recycle a tab
    // nobody is waiting on.
    if (expired()) return { finalized: true, skippedReason: 'poll-deadline-exceeded' };
    await poolTab(input.vendor, input.session.targetId, input.url, {
        owner: input.owner || 'cli-jaw',
        sessionType: input.sessionType || 'jaw',
        sessionId: input.session.sessionId,
        port: input.port,
    });
    return { finalized: true, pooled: true };
}

