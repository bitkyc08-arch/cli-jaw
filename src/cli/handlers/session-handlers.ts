// ─── Session slash command handlers ──────────────────
import type { SlashResult } from '../types.js';
import {
    createChatSession,
    listChatSessions,
    getChatSessionBySeq,
    setActiveChatSession,
    getActiveChatSession,
    forkChatSession,
} from '../../core/chat-sessions.js';
import { clearResumableSessionForScope } from '../../core/session-ops.js';
import { bumpGenerationForSessionLocalReset } from '../../agent/session-persistence.js';

export async function newSessionHandler(args: string[]): Promise<SlashResult> {
    const label = args.join(' ').trim() || undefined;
    const { seq } = createChatSession(label);
    // A new session must not resume the old one's vendor thread, and the Slack
    // prefetch latch reads the same resumable-session signal to decide whether
    // history needs re-injecting — so without this, /new left the runtime
    // resuming the conversation the user just left AND withheld the history
    // that would have replaced it (#518).
    await clearResumableSessionForScope();
    bumpGenerationForSessionLocalReset();
    return { ok: true, text: `✅ New session #${seq} created${label ? ` (${label})` : ''}. Switched.` };
}

export async function switchSessionHandler(args: string[]): Promise<SlashResult> {
    const input = args[0]?.trim();
    if (!input) {
        return { ok: false, text: '❌ Usage: /switch <number> or /N' };
    }
    const seq = parseInt(input, 10);
    if (isNaN(seq)) {
        return { ok: false, text: `❌ Invalid session number: ${input}` };
    }
    const session = getChatSessionBySeq(seq);
    if (!session) {
        return { ok: false, text: `❌ Session #${seq} not found.` };
    }
    setActiveChatSession(session.id);
    const label = session.label ? ` (${session.label})` : '';
    return { ok: true, text: `🔄 Switched to session #${seq}${label}` };
}

export async function sessionsListHandler(): Promise<SlashResult> {
    const sessions = listChatSessions();
    const active = getActiveChatSession();
    const lines = sessions.map(s => {
        const marker = s.id === active ? ' ◀' : '';
        const label = s.label ? ` "${s.label}"` : '';
        return `#${s.seq}${label} — ${s.message_count} msgs${marker}`;
    });
    return { ok: true, text: `📋 Sessions:\n${lines.join('\n')}` };
}

export async function forkSessionHandler(_args: string[]): Promise<SlashResult> {
    const { seq, copiedCount } = forkChatSession();
    return { ok: true, text: `🔀 Forked to session #${seq} (${copiedCount} messages copied). Switched.` };
}
