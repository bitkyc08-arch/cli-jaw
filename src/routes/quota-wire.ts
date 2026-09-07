/** Quota wire normalization adapted from OpenCodex src/providers/quota-wire.ts.
 * Reference b94051fe91e745806102988f6dff2fec8de078ef; MIT, see LICENSE.
 */
const QUOTA_RESPONSE_MAX_BYTES = 512 * 1024;
const QUOTA_BODY_TIMEOUT_MS = 8_000;

export function asQuotaRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

export function quotaNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

export function quotaPercent(value: unknown): number | undefined {
    const number = quotaNumber(value);
    return number === undefined ? undefined : Math.max(0, Math.min(100, number));
}

export function quotaResetIso(value: unknown): string | null {
    let milliseconds: number;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        milliseconds = value > 10_000_000_000 ? value : value * 1000;
    } else if (typeof value === 'string' && value.trim()) {
        const trimmed = value.trim();
        if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return quotaResetIso(Number(trimmed));
        milliseconds = Date.parse(trimmed);
    } else return null;
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function readQuotaBytes(response: Response, timeoutMs = QUOTA_BODY_TIMEOUT_MS): Promise<Uint8Array> {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > QUOTA_RESPONSE_MAX_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Quota response exceeds size limit');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Quota response has no body');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quota response body timed out')), timeoutMs);
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            total += value.byteLength;
            if (total > QUOTA_RESPONSE_MAX_BYTES) throw new Error('Quota response exceeds size limit');
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } catch (error) {
        // Cancellation is best effort; a broken producer must not extend the deadline.
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

export async function readQuotaJson(response: Response, timeoutMs = QUOTA_BODY_TIMEOUT_MS): Promise<unknown> {
    const bytes = await readQuotaBytes(response, timeoutMs);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
