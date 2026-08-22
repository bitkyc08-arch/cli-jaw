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
}

export async function finalizeProviderTab(input: FinalizeProviderTabInput): Promise<void> {
    updateSessionResult({
        sessionId: input.session.sessionId,
        status: 'complete',
        url: input.url,
        conversationUrl: input.url,
        answerText: input.answerText,
    });
    await poolTab(input.vendor, input.session.targetId, input.url, {
        owner: input.owner || 'cli-jaw',
        sessionType: input.sessionType || 'jaw',
        sessionId: input.session.sessionId,
        port: input.port,
    });
}
