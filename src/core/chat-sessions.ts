// ─── Chat Sessions: lightweight conversation threads ──────────
// Sessions share memory/Boss context but isolate messages.
// Session 0 = 'default' (existing), 1+ = creation order (permanent numbering).

import { db } from './db.js';
import { settings } from './config.js';
import { currentSessionScope } from './session-context.js';
import { randomUUID } from 'node:crypto';
import { broadcast } from './bus.js';
import { removeWidgetDir } from './widget-watcher.js';

export type ChatSessionRow = {
    id: string;
    seq: number;
    label: string | null;
    active_run_policy: ActiveRunPolicy | null;
    created_at: string;
    updated_at: string;
};

export type ActiveRunPolicy = 'steer' | 'followup' | 'collect' | 'interrupt';

const ACTIVE_RUN_POLICIES = new Set<ActiveRunPolicy>(['steer', 'followup', 'collect', 'interrupt']);

export function isActiveRunPolicy(value: unknown): value is ActiveRunPolicy {
    return typeof value === 'string' && ACTIVE_RUN_POLICIES.has(value as ActiveRunPolicy);
}

const listStmt = db.prepare('SELECT * FROM chat_sessions ORDER BY seq ASC');
const getBySeqStmt = db.prepare('SELECT * FROM chat_sessions WHERE seq = ?');
const getByIdStmt = db.prepare('SELECT * FROM chat_sessions WHERE id = ?');
const insertStmt = db.prepare('INSERT INTO chat_sessions (id, seq, label, active_run_policy) VALUES (?, ?, ?, ?)');
const deleteStmt = db.prepare('DELETE FROM chat_sessions WHERE id = ? AND id != \'default\'');
const maxSeqStmt = db.prepare('SELECT MAX(seq) as max_seq FROM chat_sessions');
const countMsgsStmt = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?');
const getRunPolicyStmt = db.prepare('SELECT active_run_policy FROM chat_sessions WHERE id = ?');
const setRunPolicyStmt = db.prepare('UPDATE chat_sessions SET active_run_policy = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

const getActiveStmt = db.prepare("SELECT active_chat_session FROM session WHERE id = 'default'");
const setActiveStmt = db.prepare("UPDATE session SET active_chat_session = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'");
const getBindingStmt = db.prepare('SELECT chat_session_id FROM remote_session_bindings WHERE remote_key = ?');
const touchBindingStmt = db.prepare('UPDATE remote_session_bindings SET last_seen_at=CURRENT_TIMESTAMP WHERE remote_key = ?');
const rebindStmt = db.prepare('UPDATE remote_session_bindings SET remote_key = ?, last_seen_at=CURRENT_TIMESTAMP WHERE remote_key = ?');
const bindStmt = db.prepare(`
    INSERT INTO remote_session_bindings (remote_key, chat_session_id)
    VALUES (?, ?)
    ON CONFLICT(remote_key) DO UPDATE SET
        chat_session_id=excluded.chat_session_id,
        last_seen_at=CURRENT_TIMESTAMP
`);

export function getActiveChatSession(): string {
    if (settings["multiSession"]?.enabled === true) {
        const captured = currentSessionScope()?.chatSessionId;
        if (captured) return captured;
    }
    const row = getActiveStmt.get() as { active_chat_session?: string } | undefined;
    return row?.active_chat_session || 'default';
}

export function getSessionRunPolicy(sessionId: string): ActiveRunPolicy | null {
    const row = getRunPolicyStmt.get(sessionId) as { active_run_policy?: unknown } | undefined;
    return isActiveRunPolicy(row?.active_run_policy) ? row.active_run_policy : null;
}

export function setSessionRunPolicy(sessionId: string, policy: ActiveRunPolicy | null): void {
    setRunPolicyStmt.run(policy, sessionId);
}

function defaultRunPolicy(): ActiveRunPolicy | null {
    if (settings["multiSession"]?.enabled !== true) return null;
    const configured = settings["multiSession"]?.midRunPolicy;
    return isActiveRunPolicy(configured) ? configured : 'steer';
}

export function setActiveChatSession(sessionId: string): void {
    const captured = settings["multiSession"]?.enabled === true ? currentSessionScope() : undefined;
    if (captured && captured.scope !== 'default') {
        bindStmt.run(captured.scope, sessionId);
        broadcast('session_switched', { sessionId, scope: captured.scope }, 'public');
        return;
    }
    setActiveStmt.run(sessionId);
    broadcast('session_switched', { sessionId }, 'public');
}

export function resolveOrCreateRemoteSession(remoteKey: string): string {
    return db.transaction(() => {
        const found = getBindingStmt.get(remoteKey) as { chat_session_id: string } | undefined;
        if (found) {
            touchBindingStmt.run(remoteKey);
            return found.chat_session_id;
        }
        if (remoteKey.startsWith('jaw:telegram:') && !remoteKey.includes(':thread:')) {
            const legacyKey = `${remoteKey}:thread:1`;
            const legacy = getBindingStmt.get(legacyKey) as { chat_session_id: string } | undefined;
            if (legacy) {
                rebindStmt.run(remoteKey, legacyKey);
                return legacy.chat_session_id;
            }
        }
        const id = randomUUID().slice(0, 8);
        insertStmt.run(id, getNextSeq(), remoteKey, defaultRunPolicy());
        bindStmt.run(remoteKey, id);
        return id;
    })();
}

export function createChatSession(label?: string): { id: string; seq: number } {
    const id = randomUUID().slice(0, 8);
    const seq = getNextSeq();
    insertStmt.run(id, seq, label || null, defaultRunPolicy());
    setActiveChatSession(id);
    broadcast('session_created', { id, seq, label: label || null }, 'public');
    return { id, seq };
}

export function listChatSessions(): (ChatSessionRow & { message_count: number })[] {
    const rows = listStmt.all() as ChatSessionRow[];
    return rows.map(r => ({
        ...r,
        message_count: (countMsgsStmt.get(r.id) as { cnt: number })?.cnt || 0,
    }));
}

export function getChatSessionBySeq(seq: number): ChatSessionRow | null {
    return (getBySeqStmt.get(seq) as ChatSessionRow) || null;
}

export function getChatSessionById(id: string): ChatSessionRow | null {
    return (getByIdStmt.get(id) as ChatSessionRow) || null;
}

export function deleteChatSession(sessionId: string): boolean {
    if (sessionId === 'default') return false;
    const result = deleteStmt.run(sessionId);
    if (result.changes > 0) {
        removeWidgetDir(sessionId);
        // If deleting the active session, switch back to default
        if (getActiveChatSession() === sessionId) {
            setActiveChatSession('default');
        }
        broadcast('session_list', { sessions: listChatSessions() }, 'public');
        return true;
    }
    return false;
}

export function getNextSeq(): number {
    const row = maxSeqStmt.get() as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
}

export function forkChatSession(sourceSessionId?: string): { id: string; seq: number; copiedCount: number } {
    const srcId = sourceSessionId || getActiveChatSession();
    const id = randomUUID().slice(0, 8);
    const seq = getNextSeq();
    const srcSession = getByIdStmt.get(srcId) as ChatSessionRow | undefined;
    const label = srcSession?.label ? `fork of "${srcSession.label}"` : `fork of #${srcSession?.seq ?? 0}`;
    insertStmt.run(id, seq, label, defaultRunPolicy());
    const copyResult = db.prepare(
        `INSERT INTO messages (role, content, cli, model, trace, tool_log, cost_usd, duration_ms, created_at, session_id, working_dir, trace_run_id)
         SELECT role, content, cli, model, trace, tool_log, cost_usd, duration_ms, created_at, ?, working_dir, trace_run_id
         FROM messages WHERE session_id = ? ORDER BY id ASC`
    ).run(id, srcId);
    setActiveChatSession(id);
    broadcast('session_created', { id, seq, label, forkedFrom: srcId }, 'public');
    return { id, seq, copiedCount: copyResult.changes };
}
