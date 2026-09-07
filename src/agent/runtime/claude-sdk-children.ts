import type { RuntimeEvent, RuntimeEventBody } from '../../shared/runtime-contract.js';
import type { RuntimeEventContext } from './events.js';
import type { ClaudePermissionOwner } from './claude-sdk-permissions.js';
import { RuntimeProjection, type RuntimeTranscriptObserver } from './projection.js';
import { ClaudeSdkEvents } from './claude-sdk-events.js';

export interface ClaudeChildOwner {
    context: RuntimeEventContext;
    projection: RuntimeProjection;
    isCurrent(): boolean;
    isActive(): boolean;
    canRecordTerminal?(): boolean;
    record(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
}
type Obj = Record<string, unknown>;
type Status = 'done' | 'error' | 'stopped';
type Child = { parent: string; prefix: string; owner?: ClaudeChildOwner; ancestor?: Child;
    context?: RuntimeEventContext; projection?: RuntimeProjection; mapper?: ClaudeSdkEvents; terminal?: Status;
    transcript?: RuntimeTranscriptObserver };
type Task = { child?: Child; retired?: boolean };
type Pending = { frame: Obj; child?: Child; task?: Task; bytes: number };
const MAX_CHILDREN = 128, MAX_TOOLS = 512, MAX_FRAMES = 32, BUFFER_BYTES = 64 * 1024;
const taskTypes = new Set(['task_started', 'task_progress', 'task_notification', 'task_updated']);
const resultTypes = new Set(['success', 'error_during_execution', 'error_max_turns',
    'error_max_budget_usd', 'error_max_structured_output_retries']);
function obj(raw: unknown): Obj | undefined {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Obj : undefined;
}
function id(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 1024 ? raw : undefined;
}
function sameOwner(a: RuntimeEventContext, b: RuntimeEventContext): boolean {
    return a.runId === b.runId && a.sessionId === b.sessionId && a.scope === b.scope && a.turnId === b.turnId;
}
function terminal(raw: unknown): Status | undefined {
    if (raw === 'completed') return 'done';
    if (raw === 'failed') return 'error';
    if (raw === 'killed' || raw === 'stopped') return 'stopped';
    return undefined;
}

export class ClaudeSdkChildren {
    private readonly children = new Map<string, Child>();
    private readonly tasks = new Map<string, Task>();
    private readonly tools = new Map<string, Child>();
    private readonly declaredTools = new Set<string>();
    private readonly pendingToolOwners = new Set<string>();
    private pending: Pending[] = [];
    private pendingBytes = 0;
    private incomplete = false;

    constructor(private readonly options: {
        resolveParent(toolUseId: string): ClaudeChildOwner | null;
        transcript?(context: RuntimeEventContext): RuntimeTranscriptObserver;
        resolveTranscriptParent?(context: RuntimeEventContext, nativeToolRef: string): string | null;
    }) {}

    accept(raw: unknown): boolean {
        const frame = obj(raw);
        if (!frame) return false;
        const childFrame = frame['parent_tool_use_id'] !== undefined && frame['parent_tool_use_id'] !== null;
        const taskFrame = frame['type'] === 'system' && taskTypes.has(String(frame['subtype']));
        if (!childFrame && !taskFrame) {
            this.flush();
            this.foregroundResult(frame);
            return false; // The parent mapper still owns this tool result and the parent outcome.
        }
        // Every child/task family is consumed, even when malformed, capped or unlinked.
        let child: Child | undefined, task: Task | undefined;
        try {
            if (taskFrame) {
                const taskId = id(frame['task_id']);
                if (!taskId) return true;
                task = this.tasks.get(taskId);
                if (!task) {
                    if (this.tasks.size >= MAX_CHILDREN) { this.reportCapacity(); return true; }
                    this.tasks.set(taskId, task = {});
                }
                if (task.retired) return true;
                const parent = id(frame['tool_use_id']);
                if (parent) {
                    if (task.child && task.child.parent !== parent) return true;
                    if (!task.child) {
                        const linked = this.child(parent);
                        if (linked) task.child = linked;
                    }
                }
                child = task.child;
            } else {
                const parent = id(frame['parent_tool_use_id']);
                if (!parent) return true;
                child = this.child(parent);
                if (!child) return true;
            }
            if (child) this.link(child);
            // Resolve task IDs before replay, so an earlier terminal wins over this start.
            this.flush();
            if (child?.terminal) return true;
            if (child?.mapper) this.deliver(child, frame);
            else this.buffer({ frame, ...(child ? { child } : {}), ...(task ? { task } : {}), bytes: 0 });
        } catch {
            child?.owner?.projection.report('malformed');
            if (child) this.finish(child, 'error');
        }
        return true;
    }

    /** Each productive pass consumes a buffered frame; never wait for an unrelated frame. */
    reconcile(): void {
        let pending = this.pending.length;
        for (let pass = 0; pass < MAX_FRAMES; pass++) {
            this.flush();
            if (!this.pending.length || this.pending.length >= pending) break;
            pending = this.pending.length;
        }
    }

    /** Bounded declaration handoff, independent of whether a callback is waiting. */
    drainToolOwners(): Array<readonly [string, ClaudePermissionOwner]> {
        const owners: Array<readonly [string, ClaudePermissionOwner]> = [];
        for (const id of this.pendingToolOwners) {
            const owner = this.toolOwner(id);
            if (owner) owners.push([id, owner]);
        }
        this.pendingToolOwners.clear();
        return owners;
    }

    stopOwner(context: RuntimeEventContext, status: 'stopped' | 'error' = 'stopped'): void {
        for (const child of this.children.values()) {
            // Unknown prelink frames cannot safely cross a Stop into another send.
            if (!child.owner || sameOwner(child.owner.context, context)) this.finish(child, status);
        }
        for (const task of this.tasks.values()) if (!task.child || task.child.terminal) task.retired = true;
        this.pending = this.pending.filter(p => {
            const child = p.child ?? p.task?.child;
            return child?.owner && !child.terminal && !p.task?.retired;
        });
        this.pendingBytes = this.pending.reduce((sum, p) => sum + p.bytes, 0);
    }

    resolveTool(toolUseId: string): ClaudePermissionOwner | null {
        const owner = this.toolOwner(toolUseId);
        return owner?.isCurrent() ? owner : null;
    }

    /** Provenance survives child completion; its permission predicate remains live-only. */
    private toolOwner(toolUseId: string): ClaudePermissionOwner | null {
        const child = this.tools.get(toolUseId);
        // Display persistence is not permission authority once lineage and ownership are captured.
        if (!this.declaredTools.has(toolUseId) || !child?.context) return null;
        const context = child.context;
        return { context, isCurrent: () => this.active(child), emit: body => {
            if (this.active(child)) this.record(child, context, body);
        } };
    }

    private active(child: Child): boolean {
        return !child.terminal && !!child.owner?.isCurrent() && child.owner.isActive()
            && (!child.ancestor || this.active(child.ancestor));
    }

    private child(parent: string): Child | undefined {
        let child = this.children.get(parent);
        if (!child) {
            if (this.children.size >= MAX_CHILDREN) { this.reportCapacity(); return; }
            child = { parent, prefix: 'claude-child-' + (this.children.size + 1) + '-' };
            this.children.set(parent, child);
        }
        return child;
    }

    private link(child: Child): void {
        if (child.terminal || child.mapper) return;
        if (!child.owner) {
            const ancestor = this.tools.get(child.parent);
            if (ancestor) {
                child.ancestor = ancestor;
                if (ancestor.owner) child.owner = ancestor.owner;
            }
            else {
                const owner = this.options.resolveParent(child.parent);
                if (owner) child.owner = { context: Object.freeze({ ...owner.context }), projection: owner.projection,
                    isCurrent: () => owner.isCurrent(), isActive: () => owner.isActive(),
                    canRecordTerminal: () => owner.canRecordTerminal?.() === true,
                    record: (context, body) => owner.record(context, body) };
            }
        }
        if (!child.owner) return;
        if (this.incomplete) child.owner.projection.report('capacity');
        if (!this.active(child)) { this.finish(child, 'stopped'); return; }
        const parentContext = child.ancestor?.context ?? child.owner.context;
        let parentItemId: string | null;
        if (this.options.resolveTranscriptParent) {
            if (child.ancestor && !child.ancestor.context) return;
            parentItemId = this.options.resolveTranscriptParent(parentContext, 'claude:tool:' + child.parent);
        } else {
            const projector = child.ancestor?.projection ?? child.owner.projection;
            const localId = projector?.itemId('tool', 'claude:tool:' + child.parent);
            parentItemId = localId ? (child.ancestor?.prefix ?? '') + localId : null;
        }
        if (!parentItemId) return;
        child.context = Object.freeze({ ...parentContext, parentItemId });
        if (this.options.transcript) child.transcript = this.options.transcript(child.context);
        child.projection = new RuntimeProjection(child.context, (context, body) => this.record(child, context, body),
            reason => child.owner!.projection.report(reason), child.transcript);
        child.mapper = new ClaudeSdkEvents(child.projection);
    }

    private record(child: Child, context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null {
        // Passive completion may write only existing terminal tool snapshots, never decisions.
        const terminal = child.terminal !== undefined && body.kind === 'tool' && body.status !== 'running';
        if (!child.owner || (!child.owner.isCurrent() && !(terminal && child.owner.canRecordTerminal?.()))) return null;
        if (body.kind === 'turn-start' || body.kind === 'turn-end' || body.kind === 'message' && body.phase === 'final') return null;
        const prefixed = 'itemId' in body ? { ...body, itemId: child.prefix + body.itemId } : body;
        return child.owner.record(context, prefixed);
    }

    private deliver(child: Child, frame: Obj): void {
        if (!this.active(child)) return;
        if (frame['type'] === 'system') { this.task(child, frame); return; }
        if (frame['type'] === 'result') {
            if (resultTypes.has(String(frame['subtype'])) && typeof frame['is_error'] === 'boolean')
                this.finish(child, frame['subtype'] === 'success' && !frame['is_error'] ? 'done' : 'error');
            return;
        }
        const toolIds = this.frameTools(frame);
        if (toolIds.some(toolId => this.tools.has(toolId) && this.tools.get(toolId) !== child)) return;
        if (toolIds.some(toolId => this.options.resolveParent(toolId))) return;
        const additions = new Set(toolIds.filter(toolId => !this.tools.has(toolId)));
        if (this.tools.size + additions.size > MAX_TOOLS) { child.owner?.projection.report('capacity'); return; }
        child.mapper!.accept({ ...frame, parent_tool_use_id: null });
        // Retain identity even on recorder failure; it can never be rebound to another child.
        for (const toolId of additions) this.tools.set(toolId, child);
        for (const toolId of this.frameTools(frame, true)) {
            if (this.declaredTools.has(toolId)) continue;
            this.declaredTools.add(toolId); this.pendingToolOwners.add(toolId);
        }
    }

    private frameTools(frame: Obj, declarationsOnly = false): string[] {
        let blocks: unknown = [];
        if (frame['type'] === 'assistant' || frame['type'] === 'user') blocks = obj(frame['message'])?.['content'];
        else if (frame['type'] === 'stream_event') {
            const event = obj(frame['event']);
            if (event?.['type'] === 'content_block_start') blocks = [event['content_block']];
        }
        if (!Array.isArray(blocks)) return [];
        if (blocks.length > MAX_TOOLS) throw new Error('Claude child block limit exceeded');
        const ids: string[] = [];
        for (const raw of blocks) {
            const block = obj(raw);
            if (!block || !['tool_use', 'tool_result'].includes(String(block['type']))) continue;
            if (declarationsOnly && block['type'] !== 'tool_use') continue;
            const toolId = id(block[block['type'] === 'tool_use' ? 'id' : 'tool_use_id']);
            if (toolId) ids.push(toolId);
        }
        return ids;
    }

    private task(child: Child, frame: Obj): void {
        const taskId = id(frame['task_id']);
        if (!taskId) return;
        const patch = frame['subtype'] === 'task_updated' ? obj(frame['patch']) : frame;
        if (!patch) return;
        if (frame['subtype'] === 'task_notification' && !['completed', 'failed', 'stopped'].includes(String(patch['status']))) return;
        if (frame['subtype'] === 'task_updated' && patch['status'] !== undefined
            && !['pending', 'running', 'completed', 'failed', 'killed', 'paused'].includes(String(patch['status']))) return;
        const state = terminal(patch['status']);
        const description = patch['description'], summary = frame['summary'];
        let detail = typeof summary === 'string' ? summary : typeof description === 'string' ? description : undefined;
        if (detail !== undefined && Buffer.byteLength(detail) > BUFFER_BYTES) {
            child.owner?.projection.report('capacity'); detail = '[task detail withheld]';
        }
        child.projection!.tool('claude:task:' + taskId, { name: 'Agent', status: state ?? 'running',
            ...(detail === undefined ? {} : { detail }) });
        if (state) this.finish(child, state);
    }

    private foregroundResult(frame: Obj): void {
        // SDK AgentOutput's structured completed discriminator is the only foreground signal.
        if (frame['type'] !== 'user' || obj(frame['tool_use_result'])?.['status'] !== 'completed') return;
        const content = obj(frame['message'])?.['content'];
        if (!Array.isArray(content) || content.length > MAX_TOOLS) return;
        for (const raw of content) {
            const block = obj(raw);
            if (block?.['type'] !== 'tool_result' || block['is_error'] === true) continue;
            const parent = id(block['tool_use_id']);
            const child = parent ? this.children.get(parent) : undefined;
            if (child && this.active(child)) this.finish(child, 'done');
        }
    }

    private finish(child: Child, status: Status): void {
        if (child.terminal) return;
        child.terminal = status; // fence before recorder callbacks (including reentrant Stop).
        if (!child.owner || (!child.owner.isCurrent() && !child.owner.canRecordTerminal?.())) return;
        for (const [taskId, task] of this.tasks) if (task.child === child) {
            if (child.transcript || child.projection?.itemId('tool', 'claude:task:' + taskId))
                child.projection?.tool('claude:task:' + taskId, { status });
        }
        child.mapper?.finishChild(status);
        // Child completion has no preview turn-end; its transcript still owns unfinished items.
        try { child.transcript?.close({ kind: 'turn-end', status, finalText: null }); }
        catch { child.owner.projection.report('persistence'); }
    }

    private flush(): void {
        for (const child of this.children.values()) this.link(child);
        const pending = this.pending;
        this.pending = []; this.pendingBytes = 0;
        for (const entry of pending) {
            const child = entry.child ?? entry.task?.child;
            if (entry.task?.retired || child?.terminal) continue;
            if (child) this.link(child);
            if (child?.mapper) {
                try { this.deliver(child, entry.frame); }
                catch { child.owner?.projection.report('malformed'); this.finish(child, 'error'); }
            } else { this.pending.push(entry); this.pendingBytes += entry.bytes; }
        }
    }

    private buffer(entry: Pending): void {
        if (this.pending.length >= MAX_FRAMES) { this.reportCapacity(); return; }
        // Walk before JSON serialization; bound depth, nodes and strings, reject cycles/accessors.
        let size = 0, nodes = 0;
        const visit = (value: unknown, depth: number): boolean => {
            if (++nodes > 4096 || depth > 32) return false;
            if (typeof value === 'string') size += Buffer.byteLength(value) + 2;
            else if (value && typeof value === 'object') {
                for (const key of Object.keys(value)) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    size += Buffer.byteLength(key) + 4;
                    if (!descriptor || !('value' in descriptor) || size > BUFFER_BYTES || !visit(descriptor.value, depth + 1)) return false;
                }
            } else size += 8;
            return size <= BUFFER_BYTES;
        };
        if (!visit(entry.frame, 0)) { this.reportCapacity(); return; }
        const json = JSON.stringify(entry.frame);
        entry.bytes = Buffer.byteLength(json);
        if (this.pendingBytes + entry.bytes > BUFFER_BYTES) { this.reportCapacity(); return; }
        entry.frame = JSON.parse(json) as Obj;
        this.pending.push(entry); this.pendingBytes += entry.bytes;
    }

    private reportCapacity(): void {
        this.incomplete = true;
        for (const child of this.children.values()) if (child.owner) { child.owner.projection.report('capacity'); return; }
    }
}
