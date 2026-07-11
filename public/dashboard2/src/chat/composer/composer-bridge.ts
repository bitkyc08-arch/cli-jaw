export interface ComposerRelayRequest {
    type: 'cli-jaw:composer-request';
    requestId: string;
    action: 'focus' | 'send';
    payload?: unknown;
}

export interface ComposerRelayResponse {
    type: 'cli-jaw:composer-response';
    requestId: string;
    ok: boolean;
    payload?: unknown;
    error?: string;
}

export function createComposerRelay(target: Window, targetOrigin: string, timeoutMs = 5_000) {
    if (!/^https?:\/\/[^/]+$/i.test(targetOrigin)) {
        throw new Error('Composer relay requires an explicit HTTP(S) origin');
    }
    let serial = 0;
    const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timer: number }>();
    const onMessage = (event: MessageEvent<ComposerRelayResponse>) => {
        if (event.origin !== targetOrigin || event.source !== target) return;
        const data = event.data;
        if (!data || data.type !== 'cli-jaw:composer-response') return;
        const waiter = pending.get(data.requestId);
        if (!waiter) return;
        pending.delete(data.requestId);
        window.clearTimeout(waiter.timer);
        if (data.ok) waiter.resolve(data.payload);
        else waiter.reject(new Error(data.error || 'Composer relay failed'));
    };
    window.addEventListener('message', onMessage);

    return {
        request(action: ComposerRelayRequest['action'], payload?: unknown): Promise<unknown> {
            const requestId = `composer-${Date.now().toString(36)}-${++serial}`;
            return new Promise((resolve, reject) => {
                const timer = window.setTimeout(() => {
                    pending.delete(requestId);
                    reject(new Error('Composer relay timed out'));
                }, timeoutMs);
                pending.set(requestId, { resolve, reject, timer });
                target.postMessage({ type: 'cli-jaw:composer-request', requestId, action, payload }, targetOrigin);
            });
        },
        dispose(): void {
            window.removeEventListener('message', onMessage);
            for (const waiter of pending.values()) {
                window.clearTimeout(waiter.timer);
                waiter.reject(new Error('Composer relay disposed'));
            }
            pending.clear();
        },
    };
}
