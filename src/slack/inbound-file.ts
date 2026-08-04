import { saveUpload } from '../agent/spawn.js';
import { slackApi, neededScopeFrom, type SlackFetch } from './api.js';
import type { SlackFileEvent } from './events.js';
import { withSlackDownloadSlot } from './ingress.js';
import { isSlackDownloadHost, validateSlackDownloadUrl, type SlackInboundUrlOptions } from './inbound-url.js';

export const SLACK_INBOUND_FILE_LIMIT = 50 * 1024 * 1024;
export const SLACK_INBOUND_MESSAGE_LIMIT = 100 * 1024 * 1024;
export const SLACK_INBOUND_FILE_COUNT_LIMIT = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
const MESSAGE_DOWNLOAD_CONCURRENCY = 3;
const REDIRECT_LIMIT = 3;

export type SlackInboundFileErrorCode =
    | 'external_file_unsupported' | 'private_network' | 'redirect_limit'
    | 'size_exceeded' | 'message_budget_exceeded' | 'missing_scope'
    | 'ingress_cancelled' | 'download_failed';
export type SavedSlackFile = { id: string; name: string; filePath: string; size: number };
export type FailedSlackFile = { id: string; name: string; code: SlackInboundFileErrorCode };

type AuthoritativeFile = {
    id: string;
    name: string;
    size: number;
    mode: string;
    url: string;
};

export type SlackInboundReservation = {
    reservedOriginal: number;
    reservedConsumed: number;
    borrowed: number;
    settled: boolean;
};

export type SlackInboundBudget = { unreservedCapacity: number };

export type SlackInboundFileOptions = {
    fetchImpl?: SlackFetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    resolveHost?: SlackInboundUrlOptions['resolveHost'];
};

function errorCode(error: unknown): SlackInboundFileErrorCode {
    const code = error instanceof Error ? error.message : '';
    if (code === 'external_file_unsupported' || code === 'private_network'
        || code === 'redirect_limit' || code === 'size_exceeded'
        || code === 'message_budget_exceeded' || code === 'missing_scope'
        || code === 'ingress_cancelled') return code;
    return 'download_failed';
}

export function safeSlackFileName(value: unknown, fallback = 'attachment'): string {
    const leaf = String(value || '').split(/[\\/]/).pop() || '';
    const cleaned = leaf
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[^\p{L}\p{N}._() -]/gu, '_')
        .trim();
    return cleaned ? cleaned.slice(0, 240) : fallback;
}

export function validateSlackInboundSize(value: unknown): number {
    const size = Number(value || 0);
    if (!Number.isFinite(size) || size < 0 || size > SLACK_INBOUND_FILE_LIMIT) {
        throw new Error('size_exceeded');
    }
    return Math.floor(size);
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('ingress_cancelled');
}

async function resolveAuthoritativeFile(
    token: string,
    eventFile: SlackFileEvent,
    options: SlackInboundFileOptions,
): Promise<AuthoritativeFile> {
    throwIfCancelled(options.signal);
    const id = String(eventFile.id || '');
    const name = safeSlackFileName(eventFile.name || eventFile.title, id ? `file-${id.slice(-6)}` : 'attachment');
    if (!id) throw new Error('download_failed');
    validateSlackInboundSize(eventFile.size);
    const info = await slackApi<{ file?: SlackFileEvent }>(token, 'files.info', { file: id }, {
        form: true,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    throwIfCancelled(options.signal);
    if (!info.ok) {
        if (info.error === 'missing_scope' || neededScopeFrom(info.data) === 'files:read') {
            throw new Error('missing_scope');
        }
        throw new Error('download_failed');
    }
    const file = info.data?.file;
    if (!file) throw new Error('download_failed');
    const size = validateSlackInboundSize(file.size);
    const mode = String(file.mode || eventFile.mode || '');
    const url = String(file.url_private_download || file.url_private || '');
    if (mode === 'external') {
        let slackHosted = false;
        try { slackHosted = isSlackDownloadHost(new URL(url).hostname); } catch { /* fail closed below */ }
        if (!slackHosted) throw new Error('external_file_unsupported');
    }
    if (!url) throw new Error('download_failed');
    return { id, name: safeSlackFileName(file.name || file.title, name), size, mode, url };
}

export function reserveSlackInboundBudget(
    budget: SlackInboundBudget,
    size: number,
): SlackInboundReservation | null {
    if (size > budget.unreservedCapacity) return null;
    budget.unreservedCapacity -= size;
    return { reservedOriginal: size, reservedConsumed: 0, borrowed: 0, settled: false };
}

export function settleSlackInboundReservation(
    budget: SlackInboundBudget,
    reservation: SlackInboundReservation,
    saved: boolean,
): void {
    if (reservation.settled) return;
    reservation.settled = true;
    budget.unreservedCapacity += saved
        ? reservation.reservedOriginal - reservation.reservedConsumed
        : reservation.reservedOriginal + reservation.borrowed;
    if (budget.unreservedCapacity < 0) budget.unreservedCapacity = 0;
}

function consumeBytes(budget: SlackInboundBudget, reservation: SlackInboundReservation, count: number): void {
    const reservedRemaining = reservation.reservedOriginal - reservation.reservedConsumed;
    const fromReserved = Math.min(reservedRemaining, count);
    reservation.reservedConsumed += fromReserved;
    const extra = count - fromReserved;
    if (extra <= 0) return;
    if (extra > budget.unreservedCapacity) throw new Error('message_budget_exceeded');
    budget.unreservedCapacity -= extra;
    reservation.borrowed += extra;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchSlackFile(
    token: string,
    file: AuthoritativeFile,
    budget: SlackInboundBudget,
    reservation: SlackInboundReservation,
    options: SlackInboundFileOptions,
): Promise<Buffer> {
    const fetchImpl = options.fetchImpl || fetch;
    const signal = combinedSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let current = file.url;
    for (let redirects = 0; ; redirects += 1) {
        throwIfCancelled(options.signal);
        const parsed = await validateSlackDownloadUrl(current, {
            ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
        });
        throwIfCancelled(options.signal);
        const response = await fetchImpl(parsed.href, {
            method: 'GET', redirect: 'manual', signal,
            headers: { Authorization: `Bearer ${token}` },
        });
        throwIfCancelled(options.signal);
        if (response.status >= 300 && response.status < 400) {
            if (redirects >= REDIRECT_LIMIT) throw new Error('redirect_limit');
            const location = response.headers.get('location');
            if (!location) throw new Error('download_failed');
            current = new URL(location, parsed).href;
            continue;
        }
        if (!response.ok) throw new Error('download_failed');
        const declared = response.headers.get('content-length');
        if (declared !== null) validateSlackInboundSize(Number(declared));
        if (!response.body) throw new Error('download_failed');
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let received = 0;
        try {
            while (true) {
                const item = await reader.read();
                throwIfCancelled(options.signal);
                if (item.done) break;
                const chunk = Buffer.from(item.value);
                received += chunk.length;
                if (received > SLACK_INBOUND_FILE_LIMIT) throw new Error('size_exceeded');
                consumeBytes(budget, reservation, chunk.length);
                chunks.push(chunk);
            }
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            if (options.signal?.aborted) throw new Error('ingress_cancelled');
            throw error;
        }
        return Buffer.concat(chunks, received);
    }
}

async function runBounded<T>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
    let cursor = 0;
    const worker = async () => {
        while (cursor < items.length) {
            const index = cursor++;
            await task(items[index]!, index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function downloadAndSaveSlackFiles(
    token: string,
    files: readonly SlackFileEvent[],
    options: SlackInboundFileOptions = {},
): Promise<{ saved: SavedSlackFile[]; failed: FailedSlackFile[] }> {
    const inputs = files.slice(0, SLACK_INBOUND_FILE_COUNT_LIMIT);
    const outcomes: Array<SavedSlackFile | FailedSlackFile | undefined> = new Array(files.length);
    for (let index = inputs.length; index < files.length; index += 1) {
        const file = files[index]!;
        outcomes[index] = { id: String(file.id || ''), name: safeSlackFileName(file.name || file.title), code: 'message_budget_exceeded' };
    }

    const authoritative: Array<AuthoritativeFile | undefined> = new Array(inputs.length);
    await runBounded(inputs, MESSAGE_DOWNLOAD_CONCURRENCY, async (file, index) => {
        try {
            authoritative[index] = await resolveAuthoritativeFile(token, file, options);
        } catch (error) {
            outcomes[index] = {
                id: String(file.id || ''),
                name: safeSlackFileName(file.name || file.title),
                code: errorCode(error),
            };
        }
    });

    const budget: SlackInboundBudget = { unreservedCapacity: SLACK_INBOUND_MESSAGE_LIMIT };
    const reservations: Array<SlackInboundReservation | undefined> = new Array(inputs.length);
    for (const [index, file] of authoritative.entries()) {
        if (!file || outcomes[index]) continue;
        const reservation = reserveSlackInboundBudget(budget, file.size);
        if (!reservation) {
            outcomes[index] = { id: file.id, name: file.name, code: 'message_budget_exceeded' };
        } else {
            reservations[index] = reservation;
        }
    }

    await runBounded(inputs, MESSAGE_DOWNLOAD_CONCURRENCY, async (_file, index) => {
        const file = authoritative[index];
        const reservation = reservations[index];
        if (!file || !reservation || outcomes[index]) return;
        let saved = false;
        try {
            const buffer = await withSlackDownloadSlot(() => fetchSlackFile(token, file, budget, reservation, options), options.signal);
            throwIfCancelled(options.signal);
            const filePath = saveUpload(buffer, file.name);
            saved = true;
            outcomes[index] = { id: file.id, name: file.name, filePath, size: buffer.length };
        } catch (error) {
            outcomes[index] = { id: file.id, name: file.name, code: errorCode(error) };
        } finally {
            settleSlackInboundReservation(budget, reservation, saved);
        }
    });

    const saved: SavedSlackFile[] = [];
    const failed: FailedSlackFile[] = [];
    for (const outcome of outcomes) {
        if (!outcome) continue;
        if ('filePath' in outcome) saved.push(outcome);
        else failed.push(outcome);
    }
    return { saved, failed };
}
