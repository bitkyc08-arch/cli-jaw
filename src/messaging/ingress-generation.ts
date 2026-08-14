// Current chat_sessions.generation for an inbound envelope.
//
// Envelope.conversationKey is a routing key (`telegram:123`), not
// remote_session_bindings.remote_key (`jaw:telegram:...`). Look up through
// buildRemoteBindingKey(target). Missing binding or an uninitialized
// session-generation store is generation 0 — same as a brand-new session.

import { buildRemoteBindingKey } from './session-key.js';
import { getRemoteBoundSessionId } from '../core/chat-sessions.js';
import { readSessionGeneration } from '../core/session-generation.js';
import type { InboundEnvelope } from './types.js';

export function currentGenerationForEnvelope(envelope: InboundEnvelope): number {
    try {
        const remoteKey = buildRemoteBindingKey(envelope.target);
        const sessionId = getRemoteBoundSessionId(remoteKey);
        if (!sessionId) return 0;
        return readSessionGeneration({ chatSessionId: sessionId, conversationKey: remoteKey });
    } catch {
        return 0;
    }
}
