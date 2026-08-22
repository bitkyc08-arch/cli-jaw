import { poll as chatgptPoll } from './chatgpt.js';
import { geminiPoll } from './gemini-live.js';
import { grokPoll } from './grok-live.js';
import { WebAiError } from './errors.js';
import { getSession, listSessions, pruneSessions } from './session.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import type { WebAiVendor, WebAiSessionStatus } from './types.js';

const SESSIONS_SUBCOMMANDS = new Set(['list', 'show', 'resume', 'reattach', 'prune']);

const SESSION_DURATION_RE = /^(\d+)\s*([smhdw]?)$/i;
const DURATION_MS: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export interface SessionsDeps {
    port?: number;
    getPage?: () => Promise<SessionsPageLike | null | undefined>;
}

export interface SessionsPageLike {
    url?: () => string | null;
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
}

export interface SessionsInput {
    vendor?: string;
    session?: string;
    navigate?: boolean;
    allowCopyMarkdownFallback?: boolean;
}

export function parseDurationToMs(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const match = SESSION_DURATION_RE.exec(String(value).trim());
    if (!match) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'internal',
            retryHint: 'report',
            message: `invalid duration: ${value} (expected e.g. 30d, 12h, 90m, 600s)`,
            evidence: { value },
        });
    }
    const [, num, unitRaw] = match;
    const unit = (unitRaw || 'd').toLowerCase();
    const factor = DURATION_MS[unit];
    if (!factor) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'internal',
            retryHint: 'report',
            message: `unsupported duration unit: ${unit}`,
            evidence: { value, unit },
        });
    }
    return Number(num) * factor;
}

export async function runSessionsCommand(
    args: string[],
    values: Record<string, unknown>,
    deps: SessionsDeps,
    input: SessionsInput,
): Promise<Record<string, unknown>> {
    const [sub, ...rest] = args;
    if (!sub) {
        return {
            ok: true,
            status: 'help',
            commands: ['list', 'show', 'resume', 'reattach', 'prune'],
            usage: 'jaw web-ai sessions <list|show|resume|reattach|prune> [options]',
            vendor: 'chatgpt',
            warnings: [],
        };
    }
    if (!SESSIONS_SUBCOMMANDS.has(sub)) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'internal',
            retryHint: 'report',
            message: `unknown sessions subcommand: ${sub} (expected list|show|resume|reattach|prune)`,
        });
    }
    if (sub === 'list') {
        const filter: { vendor?: WebAiVendor; status?: WebAiSessionStatus; limit?: number } = {};
        const vendorExplicit = args.includes('--vendor') || args.some(a => a.startsWith('--vendor='));
        if (vendorExplicit && values["vendor"]) filter.vendor = String(values["vendor"]) as WebAiVendor;
        if (values["status"]) filter.status = String(values["status"]) as WebAiSessionStatus;
        if (values["limit"]) filter.limit = Number(values["limit"]);
        const rows = listSessions(filter);
        return { ok: true, status: 'list', sessions: rows, vendor: 'chatgpt', warnings: [] };
    }
    if (sub === 'show') {
        const id = rest[0];
        if (!id) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: 'sessions show <id> requires a sessionId argument' });
        const session = getSession(id);
        if (!session) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: `no session record for ${id}`, evidence: { sessionId: id } });
        return { ok: true, status: 'show', session, vendor: session.vendor, warnings: [] };
    }
    if (sub === 'resume') {
        const id = rest[0] || input.session;
        if (!id) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: 'sessions resume <id> requires a sessionId (positional or --session)' });
        const session = getSession(id);
        if (!session) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: `no session record for ${id}`, evidence: { sessionId: id } });
        const pollInput = {
            vendor: session.vendor,
            session: id,
            allowCopyMarkdownFallback: input.allowCopyMarkdownFallback === true,
        };
        const port = deps.port ?? 0;
        const pollFn = session.vendor === 'gemini' ? geminiPoll : session.vendor === 'grok' ? grokPoll : chatgptPoll;
        const result = await pollFn(port, pollInput);
        return { ...result, status: result.status || 'resumed' };
    }
    if (sub === 'reattach') {
        const id = rest[0] || input.session;
        if (!id) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: 'sessions reattach <id> requires a sessionId' });
        const session = getSession(id);
        if (!session) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'internal', retryHint: 'report', message: `no session record for ${id}`, evidence: { sessionId: id } });
        const page = await deps.getPage?.();
        if (!page) {
            return { ok: false, status: 'reattach-failed', sessionId: id, vendor: session.vendor, error: 'no active page', warnings: [] };
        }
        const currentUrl = page?.url?.() || null;
        const targetUrl = session.conversationUrl || session.url;
        if (!targetUrl) {
            return { ok: false, status: 'reattach-failed', sessionId: id, vendor: session.vendor, error: 'session has no conversationUrl/url', warnings: [] };
        }
        if (currentUrl !== targetUrl) {
            if (input.navigate === true) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                return { ok: true, status: 'reattached', sessionId: id, vendor: session.vendor, url: targetUrl, warnings: [`navigated from ${currentUrl} to ${targetUrl}`] };
            }
            return {
                ok: false,
                status: 'reattach-mismatch',
                sessionId: id,
                vendor: session.vendor,
                url: currentUrl || undefined,
                conversationUrl: targetUrl,
                warnings: [`current tab ${currentUrl} does not match session conversationUrl ${targetUrl}; pass --navigate to switch tabs`],
            };
        }
        return { ok: true, status: 'reattached', sessionId: id, vendor: session.vendor, url: targetUrl, warnings: ['already on conversationUrl'] };
    }
    if (sub === 'prune') {
        const olderThanMs = values['older-than']
            ? parseDurationToMs(values['older-than'])
            : 30 * 86_400_000;
        const result = pruneSessions(stripUndefined({
            olderThanMs: olderThanMs ?? undefined,
            ...(values["status"] ? { status: String(values["status"]) as WebAiSessionStatus } : {}),
        }));
        return stripUndefined({ ok: true, status: 'pruned', ...result, vendor: 'chatgpt', warnings: [], olderThanMs: olderThanMs ?? undefined });
    }
    return { ok: false, status: 'error', vendor: 'chatgpt', warnings: [], error: 'unreachable' };
}

export function printSessionsHuman(result: unknown): void {
    if (!result) return;
    if (!isRecord(result)) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    const r = result;
    if (r["status"] === 'help') {
        console.log(String(r["usage"] || ''));
        const commands = Array.isArray(r["commands"]) ? r["commands"].map(String) : [];
        console.log(`subcommands: ${commands.join(', ')}`);
        return;
    }
    if (r["status"] === 'list') {
        const rows = Array.isArray(r["sessions"]) ? r["sessions"] : [];
        if (rows.length === 0) { console.log('(no sessions)'); return; }
        for (const s of rows) {
            if (!isRecord(s)) continue;
            const vendor = String(s["vendor"] || '');
            const status = String(s["status"] || '');
            console.log(`${String(s["sessionId"] || '')}  ${vendor.padEnd(8)}  ${status.padEnd(10)}  ${String(s["createdAt"] || '')}  ${String(s["conversationUrl"] || s["url"] || '')}`);
        }
        return;
    }
    if (r["status"] === 'show') {
        console.log(JSON.stringify(r["session"], null, 2));
        return;
    }
    if (r["status"] === 'pruned') {
        console.log(`pruned ${r["removed"]} (remaining ${r["remaining"]})`);
        return;
    }
    if (r["status"] === 'reattached') {
        console.log(`reattached to ${r["sessionId"]} at ${r["url"]}`);
        return;
    }
    if (r["status"] === 'reattach-mismatch') {
        console.log(`reattach mismatch: tab=${r["url"]} session=${r["conversationUrl"]}`);
        console.log('pass --navigate to switch tabs');
        return;
    }
    if (r["answerText"]) {
        console.log(String(r["answerText"]));
        return;
    }
    console.log(JSON.stringify(r, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
