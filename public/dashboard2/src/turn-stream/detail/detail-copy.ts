import type { DetailController, DetailRangeResult } from './detail-loader.ts';

export interface DetailCopyOptions { signal?: AbortSignal; onProgress?: (copied: number, total: number) => void; clipboard?: Pick<Clipboard, 'writeText'>; chunkLimit?: number }
export class DetailCopyError extends Error { constructor(message: string, readonly offset: number) { super(`${message} at offset ${offset}`); } }

export async function copyFullDetail(controller: DetailController, options: DetailCopyOptions = {}): Promise<void> {
    const clipboard = options.clipboard ?? navigator.clipboard;
    const limit = Math.min(options.chunkLimit ?? 262_144, 262_144);
    controller.pin('copy');
    try {
        await controller.open();
        const initial = controller.snapshot();
        if (options.signal?.aborted) throw new DOMException('Copy cancelled', 'AbortError');
        if (initial.phase === 'ready-inline' && initial.inlineText !== null && new TextEncoder().encode(initial.inlineText).byteLength <= 4 * 1024 * 1024) {
            const total = initial.totalBytes ?? new TextEncoder().encode(initial.inlineText).byteLength;
            await clipboard.writeText(initial.inlineText); options.onProgress?.(total, total); return;
        }
        const totalBytes = initial.totalBytes;
        if (totalBytes === null) throw new DetailCopyError('Missing output size', 0);
        const parts: string[] = []; let offset = 0;
        while (offset < totalBytes) {
            if (options.signal?.aborted) throw new DOMException('Copy cancelled', 'AbortError');
            let result: DetailRangeResult;
            try { result = await controller.loadRange(offset, limit); } catch (error) { throw new DetailCopyError(error instanceof Error ? error.message : 'Range failed', offset); }
            if (!result.ok || !result.chunk) throw new DetailCopyError(result.error ?? 'Range failed', offset);
            parts.push(result.chunk.text);
            const next = result.nextOffset ?? result.chunk.endExclusive;
            if (next <= offset) throw new DetailCopyError('Range made no progress', offset);
            offset = next; options.onProgress?.(Math.min(offset, totalBytes), totalBytes);
        }
        await clipboard.writeText(parts.join(''));
    } finally { controller.unpin('copy'); }
}
