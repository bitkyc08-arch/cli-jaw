import { randomUUID } from 'node:crypto';
import type { RuntimeEventIdentity, RuntimeRequestView } from '../../shared/runtime-contract.js';
import { decodeRuntimeBody, encodeRuntimeBody, RUNTIME_BODY_BYTES, sanitizeRuntimeRequestView } from '../../trace/runtime-body-codec.js';
import { stringifyTraceValue } from '../../trace/redact.js';

export type RuntimeRequestBinding = Pick<RuntimeEventIdentity, 'runId' | 'sessionId' | 'scope' | 'turnId'>;
export type RuntimeRequestChangeObserver = (sessionId: string) => void;
type RequestType = 'approval' | 'question';
type Entry = RuntimeRequestBinding & {
    requestId: string; requestType: RequestType; view: RuntimeRequestView; expiresAt: number;
    validate(value: unknown): unknown; isCurrent(): boolean; resolve(value: unknown): void;
    cancelled: unknown; timer: ReturnType<typeof setTimeout>;
};
const CAPACITY = 128;
const TTL_MS = 120_000;

/** Bounded JSON trees only: reject shared references before cloning or expanding them. */
function cancellationSnapshot(value: unknown): unknown {
    try {
        const seen = new Set<object>();
        let bytes = 0, nodes = 0;
        const consume = (size: number) => {
            bytes += size;
            if (bytes > RUNTIME_BODY_BYTES) throw new Error('limit');
        };
        const quote = (text: string) => {
            if (text.length + 2 > RUNTIME_BODY_BYTES - bytes) throw new Error('limit');
            consume(Buffer.byteLength(JSON.stringify(text)));
        };
        const copy = (item: unknown, depth: number): unknown => {
            if (++nodes > RUNTIME_BODY_BYTES || depth > 32) throw new Error('limit');
            if (item === null) { consume(4); return null; }
            if (typeof item === 'string') { quote(item); return item; }
            if (typeof item === 'boolean') { consume(item ? 4 : 5); return item; }
            if (typeof item === 'number' && Number.isFinite(item)) { consume(String(item).length); return item; }
            if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('non_json_tree');
            if (item instanceof Promise) {
                void item.catch(() => undefined);
                throw new Error('non_json_tree');
            }
            const array = Array.isArray(item);
            if (!array && Object.getPrototypeOf(item) !== Object.prototype
                && Object.getPrototypeOf(item) !== null) throw new Error('non_json_tree');
            seen.add(item); consume(2);
            const keys = Reflect.ownKeys(item).filter(key => !array || key !== 'length');
            if (keys.length > RUNTIME_BODY_BYTES - bytes || (array && keys.length !== item.length)) throw new Error('limit');
            const result: Record<string, unknown> | unknown[] = array ? [] : {};
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]!;
                if (typeof key !== 'string' || (array && key !== String(i))) throw new Error('non_json_tree');
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('non_json_tree');
                if (i) consume(1);
                if (!array) { quote(key); consume(1); }
                const child = copy(descriptor.value, depth + 1);
                Object.defineProperty(result, key, { value: child, enumerable: true });
            }
            return Object.freeze(result);
        };
        return copy(value, 0);
    } catch { throw new Error('invalid_cancellation'); }
}

function requestView(identity: RuntimeEventIdentity, requestId: string, requestType: RequestType, input: unknown): RuntimeRequestView {
    const view = sanitizeRuntimeRequestView(input);
    if (!view) throw new Error('invalid_request_view');
    const encoded = encodeRuntimeBody(identity, { kind: 'request', requestId, requestType, view });
    const serialized = stringifyTraceValue(encoded.raw);
    if (Buffer.byteLength(serialized) > RUNTIME_BODY_BYTES) throw new Error('request_view_limit');
    const event = decodeRuntimeBody(JSON.parse(serialized), identity, 'request');
    if (event?.kind !== 'request') throw new Error('invalid_request_view');
    for (const field of event.view.fields) {
        for (const option of field.options) Object.freeze(option);
        Object.freeze(field.options); Object.freeze(field);
    }
    Object.freeze(event.view.fields);
    return Object.freeze(event.view);
}

/** Ephemeral decisions, not a session cache. Native IDs remain inside validators only. */
export class RuntimeRequests {
    private readonly entries = new Map<string, Entry>();

    constructor(private changeObserver?: RuntimeRequestChangeObserver) {}

    /** One composition-owned observer; never a second collection of live requests. */
    setChangeObserver(observer: RuntimeRequestChangeObserver | undefined): void {
        this.changeObserver = observer;
    }

    private changed(sessionId: string): void {
        try {
            void Promise.resolve(this.changeObserver?.(sessionId))
                .catch(() => console.warn('[runtime] request_notice_failed'));
        } catch { console.warn('[runtime] request_notice_failed'); }
    }

    open<T>(input: RuntimeRequestBinding & {
        parentItemId?: string; requestType: RequestType; view: unknown;
        validate(value: unknown): T; cancelled: T; isCurrent(): boolean;
    }) {
        this.prune();
        if (this.entries.size >= CAPACITY) throw new Error('request_capacity');
        const { runId, sessionId, scope, turnId, parentItemId, requestType, validate, isCurrent } = input;
        if (typeof validate !== 'function' || typeof isCurrent !== 'function') throw new Error('invalid_request');
        if (!this.current({ expiresAt: Infinity, isCurrent })) throw new Error('request_not_current');
        const cancelled = cancellationSnapshot(input.cancelled);
        const requestId = randomUUID();
        const identity: RuntimeEventIdentity = { version: 1, seq: 1, runId, sessionId, scope, turnId,
            ...(parentItemId === undefined ? {} : { parentItemId }) };
        const view = requestView(identity, requestId, requestType, input.view);
        if (!this.current({ expiresAt: Infinity, isCurrent })) throw new Error('request_not_current');
        if (this.entries.size >= CAPACITY) throw new Error('request_capacity');
        let resolve!: (value: T) => void;
        const answer = new Promise<T>(yes => { resolve = yes; });
        const expiresAt = Date.now() + TTL_MS;
        const timer = setTimeout(() => this.finish(entry, cancelled), TTL_MS);
        const entry: Entry = { runId, sessionId, scope, turnId, requestType, requestId, view, expiresAt,
            validate, isCurrent, cancelled, timer,
            // Only this entry's validated answer or its captured cancellation reaches finish.
            resolve: value => resolve(value as T) };
        this.entries.set(requestId, entry);
        this.changed(sessionId);
        return { requestId, answer, expiresAt, view, cancel: () => this.finish(entry, cancelled) };
    }

    list(sessionId: string) {
        this.prune();
        return [...this.entries.values()].filter(e => e.sessionId === sessionId).map(e => ({
            runId: e.runId, sessionId: e.sessionId, scope: e.scope, turnId: e.turnId,
            requestId: e.requestId, requestType: e.requestType, expiresAt: e.expiresAt,
            view: structuredClone(e.view),
        }));
    }

    respond(requestId: string, binding: RuntimeRequestBinding, response: unknown): void {
        const entry = this.entries.get(requestId);
        if (!entry || entry.runId !== binding.runId || entry.sessionId !== binding.sessionId
            || entry.scope !== binding.scope || entry.turnId !== binding.turnId) throw new Error('request_not_current');
        this.requireCurrent(entry);
        const validated = entry.validate(response);
        if (validated !== null && (typeof validated === 'object' || typeof validated === 'function')
            && typeof (validated as { then?: unknown }).then === 'function') {
            void Promise.resolve(validated).catch(() => undefined);
            throw new Error('invalid_response');
        }
        this.requireCurrent(entry);
        this.finish(entry, validated);
    }

    cancelRun(runId: string): void {
        for (const entry of [...this.entries.values()]) if (entry.runId === runId) this.finish(entry, entry.cancelled);
    }
    private current(entry: Pick<Entry, 'expiresAt' | 'isCurrent'>): boolean {
        try { return entry.expiresAt > Date.now() && entry.isCurrent() === true; }
        catch { return false; }
    }
    private requireCurrent(entry: Entry): void {
        if (this.current(entry) && this.entries.get(entry.requestId) === entry) return;
        this.finish(entry, entry.cancelled);
        throw new Error('request_not_current');
    }
    private prune(): void {
        for (const entry of [...this.entries.values()]) if (!this.current(entry)) this.finish(entry, entry.cancelled);
    }
    private finish(entry: Entry, response: unknown): void {
        if (this.entries.get(entry.requestId) !== entry) return;
        this.entries.delete(entry.requestId);
        clearTimeout(entry.timer);
        entry.resolve(response);
        this.changed(entry.sessionId);
    }
}

export const runtimeRequests = new RuntimeRequests();
