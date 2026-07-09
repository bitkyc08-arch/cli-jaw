/**
 * /queue — TUI-side queued-message management against the existing server
 * routes (src/routes/orchestrate.ts): the same surface the Web UI's
 * pending-queue row buttons use. GET /api/orchestrate/snapshot is the
 * authoritative listing source (queue_update events only fire on mutations,
 * so a freshly attached TUI has no cache); `<n>` resolves against the ids
 * pinned by the most recent listing, then re-verifies against a fresh
 * snapshot before acting — the queue renumbers itself as it drains.
 *
 * `hold` is deliberately NOT exposed: the server hold is a single-slot,
 * ~10s auto-expiring arm guard for the Web UI's click-to-confirm, not a
 * durable per-item pause.
 */
import { apiJson } from './api.js';
import type { TuiContext } from './types.js';

export interface QueueItem { id: string; prompt: string; source?: string; ts?: number }

export interface QueueCommandResult {
    ok: boolean;
    text: string;
    /** true when a steer fired — the caller should arm stream state. */
    steered?: boolean;
}

function preview(text: string, max = 60): string {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function fetchQueueSnapshot(ctx: TuiContext): Promise<QueueItem[]> {
    const snap = await apiJson<{ queued?: QueueItem[] }>(ctx, '/api/orchestrate/snapshot');
    const items = Array.isArray(snap.queued) ? snap.queued : [];
    ctx.queueItems = items;
    return items;
}

const USAGE = 'Usage: /queue — list · /queue steer <n> — run now (interrupts current turn) · /queue drop <n> — delete';

export async function runQueueCommand(ctx: TuiContext, args: string[]): Promise<QueueCommandResult> {
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list') {
        const items = await fetchQueueSnapshot(ctx);
        ctx.queueListIds = items.map(i => i.id);
        if (!items.length) return { ok: true, text: 'Queue is empty' };
        const lines = items.map((it, i) => `${i + 1}. [${it.source || '?'}] ${preview(it.prompt)}`);
        lines.push(USAGE.replace('Usage: /queue — list · ', ''));
        return { ok: true, text: lines.join('\n') };
    }

    if (sub !== 'steer' && sub !== 'drop') return { ok: false, text: USAGE };

    const n = Number.parseInt(args[1] || '', 10);
    if (!Number.isInteger(n) || n < 1) return { ok: false, text: USAGE };
    const pinned = ctx.queueListIds;
    if (!pinned || !pinned.length) return { ok: false, text: 'Run /queue first to number the items' };
    if (n > pinned.length) return { ok: false, text: `Only ${pinned.length} item(s) in the last listing — run /queue again` };
    const id = pinned[n - 1]!;

    // Re-verify against a fresh snapshot: the queue renumbers as it drains,
    // and the server only 404s on unknown ids — a stale index would silently
    // target the wrong item without this check.
    const fresh = await fetchQueueSnapshot(ctx);
    const item = fresh.find(i => i.id === id);
    if (!item) {
        ctx.queueListIds = fresh.map(i => i.id);
        return { ok: false, text: 'Queue changed since the last listing — run /queue again' };
    }

    try {
        if (sub === 'steer') {
            await apiJson(ctx, `/api/orchestrate/queue/${encodeURIComponent(id)}/steer`, { method: 'POST', body: {} }, 15_000);
            return { ok: true, text: `↳ steering: ${preview(item.prompt, 50)}`, steered: true };
        }
        const resp = await apiJson<{ pending?: number }>(ctx, `/api/orchestrate/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return { ok: true, text: `✕ dropped: ${preview(item.prompt, 50)} (${resp.pending ?? '?'} left)` };
    } catch (err) {
        // apiJson throws with the server's error text (404 item gone, 409
        // steer already in progress) — actionable as-is.
        return { ok: false, text: `${(err as Error).message} — run /queue again` };
    }
}
