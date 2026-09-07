import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeEventContext } from '../agent/runtime/events.js';
import type { RuntimeToolPatch, RuntimeTranscriptObserver } from '../agent/runtime/projection.js';
import type { RuntimeEvent, RuntimeEventBody, RuntimePhase, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { encodeRuntimeBody, redactRuntimeContent } from '../trace/runtime-body-codec.js';
import type { CodeTurnContext } from './provider.js';
import type { CodeItem } from './wire.js';

export const CODE_ITEM_MAX_CHARS = 1_048_576;
const CODE_TURN_MAX_ITEMS = 2048;
const CODE_TURN_MAX_CHARS = 8 * CODE_ITEM_MAX_CHARS;
const WITHHELD = '[structured content withheld]';
const UNFINISHED = 'No native terminal tool result received';
type Field = 'text' | 'name' | 'input' | 'output' | 'detail';
type Source = { raw: string; safe: string; sourceChars: number; structured: boolean;
    explicitStructured: boolean; retired: boolean; reason: string; dirty: boolean };
type Entry = { item: CodeItem; context: RuntimeEventContext; fields: Map<Field, Source>; committed: boolean;
    persisted: CodeItem | null; pending: boolean; metadataOnly: boolean };

export interface CodeTurnNormalizerOptions {
    context: CodeTurnContext;
    commitItem(item: CodeItem): void;
    failPersistence(error: unknown): void;
    now?: () => number;
    maxFieldChars?: number;
    maxItems?: number;
    maxTotalChars?: number;
    coalesceMs?: number;
}

function limit(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid_code_normalizer_limit');
    return value;
}

function clip(value: string, length: number): string {
    let end = Math.max(0, length);
    if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    return value.slice(0, end);
}

function structured(value: string): boolean {
    return /^(?:\{\s*(?:"|$)|\[\s*(?:["{\[\d-]|true\b|false\b|null\b|$)|(?:`{3,}|~{3,})[ \t]*json)/i.test(value.trimStart());
}

function fenceEnd(value: string, start: number, fence: string): { start: number; end: number } | null {
    let lineStart = start;
    if (start > 0 && value[start - 1] !== '\n') {
        const newline = value.indexOf('\n', start);
        if (newline < 0) return null;
        lineStart = newline + 1;
    }
    while (lineStart < value.length) {
        const newline = value.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? value.length : newline;
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(value.slice(lineStart, lineEnd));
        if (closing && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) {
            return { start: lineStart, end: lineEnd };
        }
        if (newline < 0) break;
        lineStart = newline + 1;
    }
    return null;
}

/** Redacts complete JSON fences anywhere; incomplete fences never expose their body. */
export function redactCodeText(value: string, isStructured = false): string {
    // Apply whole-object key masking before interpreting fence-like text inside a JSON value.
    if (!/^(?:`{3,}|~{3,})/.test(value.trimStart()) && (isStructured || structured(value))) {
        value = redactRuntimeContent(value, { structured: true });
    }
    const fences = /`{3,}|~{3,}/g;
    const parts: string[] = [];
    let through = 0, found = false;
    for (let match = fences.exec(value); match; match = fences.exec(value)) {
        const headerStart = match.index + match[0].length;
        const tail = value.slice(headerStart);
        const header = /^[ \t]*json[ \t]*(?:\r?\n)?/i.exec(tail);
        const partial = /^[ \t]*(?:j|js|jso)[ \t]*$/i.test(tail);
        const unlabeled = /^[ \t]*(?:\r?\n|$)/.exec(tail);
        const bodyStart = headerStart + (header?.[0].length ?? unlabeled?.[0].length ?? 0);
        const close = fenceEnd(value, bodyStart, match[0]);
        const body = value.slice(bodyStart, close?.start ?? value.length);
        const jsonBody = unlabeled && ((!close && !body.trim()) || /^\s*(?:[\[{"\d-]|true\b|false\b|null\b)/.test(body));
        if (!header && !partial && !jsonBody) {
            // Keep ordinary code fences intact, including their closing marker.
            if (close) fences.lastIndex = close.end;
            continue;
        }
        found = true;
        parts.push(redactRuntimeContent(value.slice(through, match.index)));
        if (!close || partial) { parts.push(WITHHELD); through = value.length; break; }
        const safeBody = redactRuntimeContent(body, { structured: true });
        const padding = safeBody === body ? '' : /\s*$/.exec(body)![0];
        parts.push(value.slice(match.index, bodyStart), safeBody, padding, value.slice(close.start, close.end));
        through = close.end;
        fences.lastIndex = through;
    }
    const safe = found
        ? parts.join('') + redactRuntimeContent(value.slice(through))
        : redactRuntimeContent(value, { structured: isStructured || structured(value) });
    // Partial credential tokens must not escape while the next chunk is pending.
    return safe.replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-|AIza|AKIA)[A-Za-z0-9_-]*$/g, '[REDACTED]');
}

function sameItem(left: CodeItem, right: CodeItem, ignoreSourceChars = false): boolean {
    const { updatedAt: _leftTime, ...a } = left;
    const { updatedAt: _rightTime, ...b } = right;
    if (ignoreSourceChars && a.truncation && b.truncation) {
        b.truncation = { ...b.truncation, sourceChars: a.truncation.sourceChars };
    }
    return isDeepStrictEqual(a, b);
}

/** Owns Code items only. Session settlement and event publication belong to the caller. */
export class CodeTurnNormalizer {
    private readonly context: CodeTurnContext;
    private readonly now: () => number;
    private readonly maxFieldChars: number;
    private readonly maxItems: number;
    private readonly maxTotalChars: number;
    private readonly coalesceMs: number;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly items = new Map<string, Entry>();
    private readonly closedContexts = new Set<string>();
    private chars = 0;
    private sequence = 0;
    private failed = false;
    private stale = false;
    private finished = false;
    private finishing = false;
    private capacityNoticed = false;
    private observedAssistant = false;

    constructor(private readonly options: CodeTurnNormalizerOptions) {
        this.context = Object.freeze({ ...options.context, isCurrent: options.context.isCurrent.bind(options.context) });
        this.now = options.now ?? Date.now;
        this.maxFieldChars = limit(options.maxFieldChars, CODE_ITEM_MAX_CHARS);
        this.maxItems = limit(options.maxItems, CODE_TURN_MAX_ITEMS);
        this.maxTotalChars = limit(options.maxTotalChars, CODE_TURN_MAX_CHARS);
        this.coalesceMs = options.coalesceMs ?? 0;
        if (!Number.isSafeInteger(this.coalesceMs) || this.coalesceMs < 0 || this.coalesceMs > 2_147_483_647) {
            throw new TypeError('invalid_code_coalesce_ms');
        }
    }

    private current(context: RuntimeEventContext): boolean {
        if (this.failed || this.stale || this.finished || context.audience !== 'internal' || this.context.audience !== 'internal') return false;
        if (context.runId !== this.context.runId || context.sessionId !== this.context.sessionId
            || context.turnId !== this.context.turnId || context.scope !== this.context.scope) return false;
        if (context.parentItemId !== this.context.parentItemId) {
            const parent = context.parentItemId ? this.items.get(context.parentItemId) : undefined;
            if (!parent?.committed || parent.item.kind !== 'tool_call') return false;
        }
        let current = false;
        try { current = this.context.isCurrent() === true; } catch { /* A failed ownership predicate is stale. */ }
        if (!current) { this.stale = true; this.release(); }
        return current;
    }

    private guarded<T>(action: () => T): T {
        try { return action(); }
        catch (error) {
            if (!this.failed) {
                this.failed = true;
                this.release();
                try { this.options.failPersistence(error); } catch { throw error; }
            }
            throw error;
        }
    }

    private id(context: RuntimeEventContext, kind: CodeItem['kind'], ref: string, domain = 'native'): string {
        return 'code-' + createHash('sha256').update(JSON.stringify([
            domain, context.sessionId, context.runId, context.turnId, context.scope,
            context.parentItemId ?? null, kind, ref,
        ])).digest('hex');
    }

    private contextKey(context: RuntimeEventContext): string { return context.parentItemId ?? ''; }

    observer(context: RuntimeEventContext): RuntimeTranscriptObserver {
        const owner = Object.freeze({ ...context });
        const active = () => !this.finishing && this.current(owner) && !this.closedContexts.has(this.contextKey(owner));
        return {
            text: (kind, ref, value, operation, phase) => {
                if (active()) this.guarded(() => this.text(owner, kind, ref, value, operation, phase));
            },
            tool: (ref, patch, options) => {
                if (active()) this.guarded(() => this.tool(owner, ref, patch, options));
            },
            close: end => {
                if (!active()) return;
                this.guarded(() => {
                    if (end.kind !== 'turn-end' || !['done', 'error', 'stopped'].includes(end.status)) {
                        throw new TypeError('invalid_code_native_end');
                    }
                    this.closedContexts.add(this.contextKey(owner));
                    this.closeItems(end.status, owner);
                });
            },
        };
    }

    resolveParent(context: RuntimeEventContext, nativeToolRef: string): string | null {
        if (!this.current(context) || typeof nativeToolRef !== 'string' || !nativeToolRef) return null;
        const parent = this.items.get(this.id(context, 'tool_call', nativeToolRef));
        return parent?.committed ? parent.item.itemId : null;
    }

    private entry(context: RuntimeEventContext, kind: CodeItem['kind'], ref: string): Entry | null {
        if (typeof ref !== 'string' || !ref) throw new TypeError('invalid_code_native_reference');
        const itemId = this.id(context, kind, ref);
        const old = this.items.get(itemId);
        if (old) return old;
        if (this.items.size >= this.maxItems || this.chars >= this.maxTotalChars) {
            this.capacity(); return null;
        }
        const at = this.now();
        const entry: Entry = { context: { ...context }, fields: new Map(), committed: false,
            persisted: null, pending: false, metadataOnly: false, item: {
            itemId, kind, turnId: this.context.turnId, status: 'running', createdAt: at, updatedAt: at,
            ...(context.parentItemId === undefined ? {} : { parentItemId: context.parentItemId }),
        } };
        this.items.set(itemId, entry);
        return entry;
    }

    private source(entry: Entry, field: Field, value: string, append = false, hint?: boolean, immediate = false): void {
        if (typeof value !== 'string') throw new TypeError('invalid_code_native_text');
        let old = entry.fields.get(field);
        if (old?.dirty && (old.raw.length + value.length > this.maxFieldChars
            || this.chars + value.length > this.maxTotalChars) && append) {
            this.source(entry, field, old.raw, false, old.explicitStructured, true);
            old = entry.fields.get(field);
        }
        const sourceChars = Math.min(Number.MAX_SAFE_INTEGER, (append ? old?.sourceChars ?? 0 : 0) + value.length);
        const explicitStructured = hint ?? (append ? old?.explicitStructured ?? false : false);
        let isStructured = explicitStructured || (append && old?.retired === true && old.structured) || structured(value);
        const oldCharge = (old?.raw.length ?? 0) + (old?.safe.length ?? 0);
        const available = this.maxTotalChars - this.chars + oldCharge;
        const length = (append ? old?.raw.length ?? 0 : 0) + value.length;
        let raw = '', safe: string, retired = false, reason = '', dirty = false;
        if ((append && old?.retired) || length > this.maxFieldChars || length > available) {
            retired = true;
            reason = length > this.maxFieldChars ? 'field_limit' : old?.reason || 'total_limit';
            // A retired prefix never accepts more fragments. A replacement can recover it.
            safe = isStructured ? WITHHELD : append && old ? old.safe : redactCodeText(value);
        } else {
            raw = append ? (old?.raw ?? '') + value : value;
            dirty = !immediate && this.coalesceMs > 0 && entry.committed;
            isStructured = explicitStructured || (dirty ? old?.structured === true || structured(value) : structured(raw));
            safe = dirty ? old?.safe ?? '' : redactCodeText(raw, isStructured);
        }
        if (safe.length > this.maxFieldChars || raw.length + safe.length > available) {
            reason ||= safe.length > this.maxFieldChars ? 'field_limit' : 'total_limit';
            retired = true;
            if (dirty) { safe = redactCodeText(raw, isStructured); dirty = false; }
            raw = '';
            safe = isStructured ? WITHHELD : safe;
        }
        safe = clip(safe, Math.min(this.maxFieldChars, available));
        if (!dirty && !reason && safe.includes(WITHHELD) && (isStructured || /`{3,}|~{3,}/.test(raw))) {
            reason = 'structured_incomplete';
        }
        entry.fields.set(field, { raw, safe, sourceChars, structured: isStructured, explicitStructured, retired, reason, dirty });
        this.chars += raw.length + safe.length - oldCharge;
    }

    private save(entry: Entry, force = false): void {
        if (!this.current(entry.context)) return;
        const control = !entry.committed || entry.item.kind === 'permission_request' || entry.item.kind === 'notice'
            || entry.item.status !== entry.persisted?.status;
        if (!force && !control && this.coalesceMs > 0 && [...entry.fields.values()].some(source => source.dirty)) {
            entry.pending = true; entry.metadataOnly = false;
            if ([...entry.fields.values()].some(source => source.retired)) this.capacity();
            this.schedule(); return;
        }
        for (const [field, source] of entry.fields) {
            if (source.dirty) this.source(entry, field, source.raw, false, source.explicitStructured, true);
        }
        const next: CodeItem = { ...entry.item };
        const read = (field: Field) => entry.fields.get(field)?.safe;
        if (read('text') !== undefined) next.text = read('text')!;
        if (next.kind === 'tool_call') next.tool = {
            name: read('name') || 'tool',
            ...(read('input') === undefined ? {} : { input: read('input')! }),
            ...(read('output') === undefined ? {} : { output: read('output')! }),
            ...(read('detail') === undefined ? {} : { detail: read('detail')! }),
        };
        const sources = [...entry.fields.values()];
        const reasons = [...new Set(sources.map(source => source.reason).filter(Boolean))];
        if (reasons.length) next.truncation = {
            storedChars: sources.reduce((sum, source) => sum + source.safe.length, 0),
            sourceChars: sources.reduce((sum, source) => Math.min(Number.MAX_SAFE_INTEGER, sum + source.sourceChars), 0),
            reason: reasons.join(','),
        };
        else delete next.truncation;
        if (entry.persisted && sameItem(entry.persisted, next)) {
            entry.pending = false; this.clearIdleTimer(); return;
        }
        if (!force && !control && entry.persisted && sources.some(source => source.retired)
            && sameItem(entry.persisted, next, true)) {
            entry.pending = true; entry.metadataOnly = true; this.clearIdleTimer(); return;
        }
        if (!force && !control && this.coalesceMs > 0) {
            entry.pending = true; entry.metadataOnly = false;
            if (sources.some(source => source.retired)) this.capacity();
            this.schedule(); return;
        }
        next.updatedAt = this.now();
        this.options.commitItem(structuredClone(next));
        entry.item = next;
        entry.persisted = { ...next };
        entry.committed = true;
        entry.pending = false;
        this.clearIdleTimer();
        if (sources.some(source => source.retired)) this.capacity();
    }

    private schedule(): void {
        if (this.timer !== undefined || this.finishing || !this.current(this.context)) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            try { this.guarded(() => this.flush()); }
            catch { /* guarded latched the failure before it reaches this timer boundary. */ }
        }, this.coalesceMs);
        this.timer.unref?.();
    }

    private clearIdleTimer(): void {
        if ([...this.items.values()].some(entry => entry.pending && !entry.metadataOnly)) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private flush(context?: RuntimeEventContext, final = false): void {
        if (!this.current(this.context)) return;
        for (const entry of this.items.values()) {
            if (context && this.contextKey(entry.context) !== this.contextKey(context)) continue;
            if (entry.pending && (final || !entry.metadataOnly)) this.save(entry, true);
        }
        this.clearIdleTimer();
    }

    private capacity(): void {
        if (this.capacityNoticed || !this.current(this.context)) return;
        this.capacityNoticed = true;
        const at = this.now();
        // One reserved control item remains writable even when content capacity is exhausted.
        this.options.commitItem({ itemId: this.id(this.context, 'notice', 'capacity', 'control'), turnId: this.context.turnId,
            kind: 'notice', status: 'done', text: 'Code transcript capacity reached; some content was truncated.',
            truncation: { storedChars: 0, sourceChars: 0, reason: 'capacity' }, createdAt: at, updatedAt: at });
    }

    private text(context: RuntimeEventContext, kind: 'message' | 'reasoning', ref: string, value: string,
        operation: 'append' | 'replace', phase: RuntimePhase): void {
        if (!['message', 'reasoning'].includes(kind) || !['append', 'replace'].includes(operation)
            || !['commentary', 'final', 'unknown'].includes(phase)) throw new TypeError('invalid_code_native_patch');
        if (kind === 'message' && context.parentItemId === this.context.parentItemId) this.observedAssistant = true;
        const entry = this.entry(context, kind === 'message' ? 'assistant_message' : 'reasoning', ref);
        if (!entry) return;
        if (phase !== 'unknown' || entry.item.phase === undefined) entry.item.phase = phase;
        this.source(entry, 'text', value, operation === 'append');
        this.save(entry);
    }

    private tool(context: RuntimeEventContext, ref: string, patch: RuntimeToolPatch,
        options: { allowTerminalUpdates?: boolean }): void {
        if (!patch || typeof patch !== 'object' || (patch.status !== undefined
            && !['running', 'done', 'error', 'stopped'].includes(patch.status))) throw new TypeError('invalid_code_native_tool');
        if ((patch.inputStructured !== undefined && typeof patch.inputStructured !== 'boolean')
            || (patch.outputStructured !== undefined && typeof patch.outputStructured !== 'boolean')) {
            throw new TypeError('invalid_code_native_structure_hint');
        }
        const entry = this.entry(context, 'tool_call', ref);
        if (!entry) return;
        const terminal = entry.item.status !== 'running';
        const replaceTerminal = options.allowTerminalUpdates === true && patch.status !== undefined && patch.status !== 'running';
        const nameSource = entry.fields.get('name');
        const name = nameSource?.dirty ? nameSource.raw : nameSource?.safe;
        if (patch.name && (!name || name === 'tool')) {
            this.source(entry, 'name', patch.name);
        }
        if (patch.input !== undefined && (!terminal || replaceTerminal || !entry.fields.has('input'))) {
            this.source(entry, 'input', patch.input, false, patch.inputStructured);
        }
        if (!terminal || replaceTerminal) {
            if (patch.status !== undefined) entry.item.status = patch.status === 'stopped' ? 'cancelled' : patch.status;
            if (patch.detail !== undefined) this.source(entry, 'detail', patch.detail);
            if (patch.output !== undefined) this.source(entry, 'output', patch.output, false, patch.outputStructured);
            else if (patch.delta !== undefined) this.source(entry, 'output', patch.delta, true, patch.outputStructured);
        }
        this.save(entry);
    }

    record(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null {
        if (this.finishing || !this.current(context)) return null;
        return this.guarded(() => {
            const identity = { version: 1 as const, runId: context.runId, sessionId: context.sessionId,
                scope: context.scope, turnId: context.turnId, seq: ++this.sequence,
                ...(context.parentItemId === undefined ? {} : { parentItemId: context.parentItemId }) };
            // Full terminal content belongs to finish/observer, not the bounded preview event.
            const prepared = body.kind === 'request' ? { ...body, view: { ...body.view,
                title: redactCodeText(body.view.title), fields: body.view.fields.map(field => ({ ...field,
                    label: redactCodeText(field.label), options: field.options.map(option => ({ ...option, label: redactCodeText(option.label) })),
                })) } } : body;
            const { body: safe } = encodeRuntimeBody(identity, prepared.kind === 'turn-end' ? { ...prepared, finalText: null } : prepared);
            if (safe.kind === 'request' && !this.closedContexts.has(this.contextKey(context))) this.request(context, safe);
            if (safe.kind === 'request-settled') {
                if (!this.items.has(this.id(context, 'notice', safe.requestId))) {
                    const entry = this.entry(context, 'permission_request', safe.requestId);
                    if (entry && (entry.item.status === 'pending' || entry.item.status === 'running')) {
                        entry.item.status = 'done'; this.save(entry);
                    }
                }
            }
            if (!this.current(context)) return null;
            return { ...safe, ...identity };
        });
    }

    private request(context: RuntimeEventContext, body: Extract<RuntimeEventBody, { kind: 'request' }>): void {
        if (this.items.has(this.id(context, 'permission_request', body.requestId))
            || this.items.has(this.id(context, 'notice', body.requestId))) return;
        const field = body.view.fields[0];
        const supported = body.requestType === 'approval' && body.view.fields.length === 1 && field
            && !field.multiSelect && !field.allowFreeform && field.options.length > 0;
        const permission = supported ? {
            permissionId: body.requestId, sessionId: this.context.sessionId, turnId: this.context.turnId,
            epoch: this.context.epoch, title: body.view.title, detail: field.label,
            options: field.options.map(option => ({ optionId: option.id, label: option.label, kind: 'approval' })),
            requestedAt: this.now(),
        } : undefined;
        const permissionChars = permission ? JSON.stringify(permission).length : 0;
        if (permission && (permissionChars > this.maxTotalChars - this.chars
            || [permission.title, permission.detail, ...permission.options.map(option => option.label)]
                .some(label => label.length > this.maxFieldChars))) { this.capacity(); return; }
        const entry = this.entry(context, supported ? 'permission_request' : 'notice', body.requestId);
        if (!entry || entry.item.status !== 'running') return;
        if (!supported) {
            entry.item.status = 'done';
            this.source(entry, 'text', 'Unsupported native question or permission shape; no flat answer is available.');
        } else if (permission) {
            entry.item.status = 'pending';
            entry.item.permission = permission;
            this.chars += permissionChars;
        }
        this.save(entry);
    }

    private closeItems(status: RuntimeTurnOutcome['status'], context?: RuntimeEventContext): void {
        for (const entry of this.items.values()) {
            if (context && this.contextKey(entry.context) !== this.contextKey(context)) continue;
            if (entry.item.status !== 'running' && entry.item.status !== 'pending') continue;
            const unfinished = entry.item.kind === 'tool_call' || entry.item.kind === 'permission_request';
            entry.item.status = status === 'error' ? 'error' : status === 'stopped' || unfinished ? 'cancelled' : 'done';
            const detailSource = entry.fields.get('detail');
            const detail = detailSource?.dirty ? detailSource.raw : detailSource?.safe;
            if (entry.item.kind === 'tool_call' && !detail) this.source(entry, 'detail', UNFINISHED);
            this.save(entry, true);
            for (const source of entry.fields.values()) { this.chars -= source.raw.length; source.raw = ''; }
        }
        this.flush(context, true);
    }

    finish(outcome: RuntimeTurnOutcome): void {
        if (this.finishing || !this.current(this.context)) return;
        this.finishing = true;
        this.guarded(() => {
            if (!['done', 'error', 'stopped'].includes(outcome.status) || (outcome.finalText !== null
                && typeof outcome.finalText !== 'string') || typeof outcome.partialText !== 'string') {
                throw new TypeError('invalid_code_turn_outcome');
            }
            if (!this.observedAssistant) {
                const text = outcome.finalText ?? (outcome.partialText || null);
                if (text !== null) this.text(this.context, 'message', 'outcome-fallback', text, 'replace',
                    outcome.finalText === null ? 'unknown' : 'final');
            }
            this.closeItems(outcome.status);
            this.finished = true;
            this.release();
        });
    }

    private release(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        for (const entry of this.items.values()) { entry.fields.clear(); entry.pending = false; }
        this.chars = 0;
    }
}
