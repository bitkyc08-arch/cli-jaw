import type { PendingItem } from '../../../../../src/shared/chat-events.ts';

export type PendingQueueAction = 'steer' | 'delete';
export type PendingQueuePhase = 'armed' | 'submitting' | 'error';

export interface PendingQueueOverlay {
    action: PendingQueueAction;
    phase: PendingQueuePhase;
    message?: string;
}

export interface PendingQueueRow {
    item: PendingItem;
    overlay: PendingQueueOverlay | null;
}

export interface PendingQueueSnapshot {
    scope: string;
    rows: readonly PendingQueueRow[];
    version: number;
}

export interface PendingQueueTimer {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface PendingQueueMutationApi {
    hold(id: string): Promise<void>;
    releaseHold(id: string): Promise<void>;
    steer(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    refetch(): Promise<readonly PendingItem[]>;
}

interface ArmedTimer {
    handle: unknown;
    token: number;
}

const browserTimer: PendingQueueTimer = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function pendingQueueKey(scope: string, itemId: string): string {
    return `${scope}\u0000${itemId}`;
}

function sameItems(a: readonly PendingItem[], b: readonly PendingItem[]): boolean {
    return a.length === b.length && a.every((item, index) => {
        const other = b[index];
        return other !== undefined
            && item.id === other.id
            && item.prompt === other.prompt
            && item.source === other.source
            && item.ts === other.ts;
    });
}

export class PendingQueueMachine {
    private readonly api: PendingQueueMutationApi;
    private readonly timer: PendingQueueTimer;
    private readonly armDelayMs: number;
    private readonly itemsByScope = new Map<string, readonly PendingItem[]>();
    private readonly overlays = new Map<string, PendingQueueOverlay>();
    private readonly timers = new Map<string, ArmedTimer>();
    private readonly operations = new Map<string, number>();
    private readonly listeners = new Set<() => void>();
    private scope = '';
    private version = 0;
    private token = 0;
    private cachedSnapshot: PendingQueueSnapshot | null = null;

    constructor(api: PendingQueueMutationApi, options: {
        timer?: PendingQueueTimer;
        armDelayMs?: number;
    } = {}) {
        this.api = api;
        this.timer = options.timer ?? browserTimer;
        this.armDelayMs = options.armDelayMs ?? 3_000;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): PendingQueueSnapshot => {
        if (this.cachedSnapshot) return this.cachedSnapshot;
        const rows = (this.itemsByScope.get(this.scope) ?? []).map(item => ({
            item,
            overlay: this.overlays.get(pendingQueueKey(this.scope, item.id)) ?? null,
        }));
        this.cachedSnapshot = { scope: this.scope, rows, version: this.version };
        return this.cachedSnapshot;
    };

    setScope(scope: string): void {
        if (scope === this.scope) return;
        const previousScope = this.scope;
        this.scope = scope;
        for (const [key, armed] of this.timers) {
            if (!key.startsWith(`${previousScope}\u0000`)) continue;
            this.timer.clearTimeout(armed.handle);
            this.timers.delete(key);
            const overlay = this.overlays.get(key);
            if (overlay?.action === 'steer') {
                const id = key.slice(previousScope.length + 1);
                void this.api.releaseHold(id).catch(() => undefined);
            }
            this.overlays.delete(key);
        }
        for (const key of this.overlays.keys()) {
            if (key.startsWith(`${previousScope}\u0000`)) this.overlays.delete(key);
        }
        for (const key of this.operations.keys()) {
            if (key.startsWith(`${previousScope}\u0000`)) this.operations.delete(key);
        }
        this.emit();
    }

    reconcile(scope: string, incoming: readonly PendingItem[]): void {
        const seen = new Set<string>();
        const items = incoming.filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
        const previous = this.itemsByScope.get(scope) ?? [];
        let changed = !sameItems(previous, items);
        this.itemsByScope.set(scope, items);

        for (const [key, overlay] of this.overlays) {
            if (!key.startsWith(`${scope}\u0000`)) continue;
            const id = key.slice(scope.length + 1);
            if (seen.has(id)) continue;
            const armed = this.timers.get(key);
            if (armed) this.timer.clearTimeout(armed.handle);
            this.timers.delete(key);
            this.operations.delete(key);
            this.overlays.delete(key);
            changed = true;
            void overlay;
        }
        if (changed) this.emit();
    }

    activate(itemId: string, action: PendingQueueAction): void {
        const scope = this.scope;
        const item = (this.itemsByScope.get(scope) ?? []).find(candidate => candidate.id === itemId);
        if (!item) return;
        const key = pendingQueueKey(scope, itemId);
        const overlay = this.overlays.get(key);
        if (overlay?.phase === 'armed') {
            this.cancel(scope, itemId, overlay.action);
            return;
        }
        if (overlay?.phase === 'submitting') return;

        if (action === 'steer') this.cancelOtherArmedSteers(key);

        const token = ++this.token;
        const handle = this.timer.setTimeout(() => {
            void this.submit(scope, itemId, action, token);
        }, this.armDelayMs);
        this.timers.set(key, { handle, token });
        this.overlays.set(key, { action, phase: 'armed' });
        this.emit();
        if (action === 'steer') void this.api.hold(itemId).catch(() => undefined);
    }

    dispose(): void {
        for (const [key, armed] of this.timers) {
            this.timer.clearTimeout(armed.handle);
            const overlay = this.overlays.get(key);
            if (overlay?.action === 'steer' && overlay.phase === 'armed') {
                const separator = key.indexOf('\u0000');
                const id = key.slice(separator + 1);
                void this.api.releaseHold(id).catch(() => undefined);
            }
        }
        this.timers.clear();
        this.operations.clear();
        this.overlays.clear();
        this.listeners.clear();
        this.cachedSnapshot = null;
    }

    private cancel(scope: string, itemId: string, action: PendingQueueAction): void {
        const key = pendingQueueKey(scope, itemId);
        const armed = this.timers.get(key);
        if (armed) this.timer.clearTimeout(armed.handle);
        this.timers.delete(key);
        this.overlays.delete(key);
        this.emit();
        if (action === 'steer') void this.api.releaseHold(itemId).catch(() => undefined);
    }

    private cancelOtherArmedSteers(exceptKey: string): void {
        for (const [key, overlay] of this.overlays) {
            if (key === exceptKey || overlay.action !== 'steer' || overlay.phase !== 'armed') continue;
            const separator = key.indexOf('\u0000');
            this.cancel(key.slice(0, separator), key.slice(separator + 1), 'steer');
        }
    }

    private async submit(
        scope: string,
        itemId: string,
        action: PendingQueueAction,
        token: number,
    ): Promise<void> {
        const key = pendingQueueKey(scope, itemId);
        if (scope !== this.scope || this.timers.get(key)?.token !== token) return;
        this.timers.delete(key);
        this.operations.set(key, token);
        this.overlays.set(key, { action, phase: 'submitting' });
        this.emit();

        let failed = false;
        try {
            await this.api[action](itemId);
        } catch (error) {
            failed = true;
            if (scope === this.scope
                && this.operations.get(key) === token
                && this.overlays.get(key)?.phase === 'submitting') {
                this.overlays.set(key, {
                    action,
                    phase: 'error',
                    message: error instanceof Error ? error.message : 'Queue action failed',
                });
                this.emit();
            }
        }

        if (scope !== this.scope || this.operations.get(key) !== token) return;

        try {
            const items = await this.api.refetch();
            if (scope !== this.scope || this.operations.get(key) !== token) return;
            const version = this.version;
            this.operations.delete(key);
            this.overlays.delete(key);
            this.reconcile(scope, items);
            if (this.version === version) this.emit();
        } catch {
            if (!failed && scope === this.scope && this.operations.get(key) === token) {
                this.operations.delete(key);
                this.overlays.delete(key);
                this.emit();
            }
        }
    }

    private emit(): void {
        this.version += 1;
        this.cachedSnapshot = null;
        for (const listener of this.listeners) listener();
    }
}
