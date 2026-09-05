import type { ClaudeChildOwner } from './claude-sdk-children.js';
import type { ClaudePermissionOwner } from './claude-sdk-permissions.js';

type Waiting = { resolve(owner: ClaudePermissionOwner | null): void; timer: ReturnType<typeof setTimeout> };
function object(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function claudeToolIds(raw: Record<string, unknown>): string[] {
    let blocks: unknown[] = [];
    if (raw['type'] === 'assistant') {
        const content = object(raw['message'])?.['content'];
        if (Array.isArray(content) && content.length <= 512) blocks = content;
    } else if (raw['type'] === 'stream_event') {
        const event = object(raw['event']);
        if (event?.['type'] === 'content_block_start') blocks = [event['content_block']];
    }
    return blocks.flatMap(value => {
        const block = object(value), id = block?.['id'];
        return block?.['type'] === 'tool_use' && typeof id === 'string' && id.length > 0 && id.length <= 1024 ? [id] : [];
    });
}

/** Protocol tool IDs bind to a captured send, never to whichever borrower is current later. */
export class ClaudeSdkOwners {
    private readonly parents = new Map<string, ClaudeChildOwner>();
    private readonly permissions = new Map<string, ClaudePermissionOwner>();
    private readonly waiters = new Map<string, Set<Waiting>>();
    private readonly retired = new Set<string>();
    private waiterCount = 0;
    private closed = false;
    private exhausted = false;
    get saturated(): boolean { return this.exhausted; }

    bind(id: string, permission: ClaudePermissionOwner, parent?: ClaudeChildOwner): void {
        if (this.closed) return;
        if (this.exhausted) throw new Error('claude_tool_owner_capacity');
        if (this.retired.has(id)) throw new Error('claude_tool_owner_retired');
        const old = this.permissions.get(id);
        if (old && old.context !== permission.context) throw new Error('claude_tool_owner_collision');
        if (!old && this.permissions.size >= 512) throw new Error('claude_tool_owner_capacity');
        this.permissions.set(id, permission);
        if (parent) this.parents.set(id, parent);
        const waiters = this.waiters.get(id); this.waiters.delete(id);
        for (const waiter of waiters ?? []) { this.waiterCount--; clearTimeout(waiter.timer); waiter.resolve(permission.isCurrent() ? permission : null); }
    }
    parent(id: string): ClaudeChildOwner | null { return this.parents.get(id) ?? null; }
    resolvePending(resolve: (id: string) => ClaudePermissionOwner | null): void {
        for (const id of [...this.waiters.keys()]) {
            const owner = resolve(id);
            if (owner) this.bind(id, owner);
        }
    }
    resolve(id: string): Promise<ClaudePermissionOwner | null> {
        if (this.exhausted) return Promise.resolve(null);
        const owner = this.permissions.get(id);
        if (owner) return Promise.resolve(owner.isCurrent() ? owner : null);
        if (this.closed || this.retired.has(id) || this.waiterCount >= 32 || typeof id !== 'string' || !id || id.length > 1024) return Promise.resolve(null);
        return new Promise(resolve => {
            this.waiterCount++;
            const waiting: Waiting = { resolve, timer: setTimeout(() => {
                this.waiterCount--;
                const entries = this.waiters.get(id); entries?.delete(waiting);
                if (!entries?.size) this.waiters.delete(id);
                resolve(null);
            }, 1000) };
            let entries = this.waiters.get(id);
            if (!entries) { entries = new Set(); this.waiters.set(id, entries); }
            entries.add(waiting);
        });
    }
    cancelPending(): void {
        const groups = [...this.waiters.values()]; this.waiters.clear(); this.waiterCount = 0;
        for (const group of groups) for (const entry of group) { clearTimeout(entry.timer); entry.resolve(null); }
    }
    retire(context: ClaudePermissionOwner['context']): void {
        for (const [id, owner] of this.permissions) {
            if (owner.context.runId !== context.runId || owner.context.turnId !== context.turnId
                || owner.context.sessionId !== context.sessionId || owner.context.scope !== context.scope) continue;
            this.permissions.delete(id); this.parents.delete(id);
            if (this.retired.size < 512) this.retired.add(id);
            if (this.retired.size >= 512) this.exhausted = true;
        }
    }
    close(): void { this.closed = true; this.cancelPending(); this.parents.clear(); this.permissions.clear(); }
}
