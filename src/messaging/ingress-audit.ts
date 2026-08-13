// ─── Ingress replay audit trail ──────────────────────
// A replay re-runs somebody's message. Who asked, why, and what state it was in
// beforehand are the facts you want when the same message turns up twice and nobody
// remembers touching it — so they are written before anyone can be asked.
//
// Append-only JSONL rather than a table: this is evidence, and a file that is only
// ever appended to is harder to quietly revise than a row that can be updated.

import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';

export type IngressAuditEntry = {
    ts: number;
    action: 'replay';
    channel: string;
    accountId: string;
    eventId: string;
    priorState: string;
    newState: string;
    reason: string;
    forced: boolean;
};

export function ingressAuditPath(): string {
    return path.join(JAW_HOME, 'messaging-ingress-audit.jsonl');
}

export function appendIngressAudit(entry: IngressAuditEntry): void {
    const file = ingressAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

/** Most recent first. A malformed line is skipped rather than failing the read: a
 *  partially written tail must not hide the history before it. */
export function readIngressAudit(limit = 20): IngressAuditEntry[] {
    const file = ingressAuditPath();
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const entries: IngressAuditEntry[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line) as IngressAuditEntry); }
        catch { /* skip a torn line, keep the rest */ }
    }
    return entries.reverse().slice(0, limit);
}
