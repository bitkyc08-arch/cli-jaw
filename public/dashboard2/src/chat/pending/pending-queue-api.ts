import type { PendingItem } from '../../../../../src/shared/chat-events.ts';
import type { PendingQueueMutationApi } from './pending-queue-machine.ts';

interface QueueSnapshotResponse {
    queued: PendingItem[];
}

export class PendingQueueHttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'PendingQueueHttpError';
    }
}

export function createPendingQueueApi(
    port: number,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): PendingQueueMutationApi {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs ?? 8_000;
    const base = `/i/${port}/api/orchestrate/queue`;

    async function request(path: string, method: string): Promise<void> {
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(path, {
                method,
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!response.ok) throw new PendingQueueHttpError(response.status, `Queue request failed (${response.status})`);
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Queue request timed out');
            throw error;
        } finally {
            globalThis.clearTimeout(timeout);
        }
    }

    const itemPath = (id: string, suffix = '') => `${base}/${encodeURIComponent(id)}${suffix}`;
    return {
        hold: id => request(itemPath(id, '/hold'), 'POST'),
        releaseHold: id => request(itemPath(id, '/hold'), 'DELETE'),
        steer: id => request(itemPath(id, '/steer'), 'POST'),
        delete: id => request(itemPath(id), 'DELETE'),
        async refetch() {
            const response = await fetchImpl(`/i/${port}/api/orchestrate/snapshot`, {
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) throw new PendingQueueHttpError(response.status, `Queue snapshot failed (${response.status})`);
            const snapshot = await response.json() as QueueSnapshotResponse;
            return Array.isArray(snapshot.queued) ? snapshot.queued : [];
        },
    };
}
