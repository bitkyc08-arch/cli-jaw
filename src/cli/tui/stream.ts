/**
 * Footer-safe streaming sink.
 * Buffers assistant deltas and renders+commits only *complete* markdown blocks
 * (a blank line outside a fenced code block, or a just-closed fence). The
 * in-progress block is held until its boundary completes; end() flushes the rest.
 * This guarantees marked always sees complete blocks and the scroll-region footer
 * is never corrupted by a half-rendered fence/table (doc 15 §2).
 */
import { renderMarkdown } from './markdown.js';
import { renderMarkdownJawcode, isInitialized } from './jawcode-render.js';

export interface StreamSink {
    push(chunk: string): void;
    end(): void;
}

export interface StreamSinkOpts {
    write: (s: string) => void;
    width: number;
    gutter?: string;
}

export function createStreamSink(opts: StreamSinkOpts): StreamSink {
    let buf = '';
    const flush = (force: boolean): void => {
        const idx = force ? buf.length : findSafeCommitPoint(buf);
        if (idx <= 0) return;
        const seg = buf.slice(0, idx);
        buf = buf.slice(idx);
        // gutter defaulted here so MdOpts.gutter is `string`, not `string | undefined`
        // (tsconfig exactOptionalPropertyTypes).
        if (seg.trim()) {
            if (isInitialized()) {
                const lines = renderMarkdownJawcode(seg, opts.width);
                opts.write(lines.join('\n') + '\n');
            } else {
                opts.write(renderMarkdown(seg, { width: opts.width, gutter: opts.gutter ?? '  ' }));
            }
        }
    };
    return {
        push(chunk: string): void { buf += chunk; flush(false); },
        end(): void { flush(true); },
    };
}

/** Largest index that ends on a completed block boundary outside any open fence. */
export function findSafeCommitPoint(s: string): number {
    const lines = s.split('\n');
    let inFence = false;
    let safe = 0;
    let pos = 0;
    for (const line of lines) {
        const end = pos + line.length + 1;
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            if (!inFence) safe = end; // a fence just closed → safe to commit through it
        } else if (!inFence && line.trim() === '') {
            safe = end; // blank line outside a fence → block boundary
        }
        pos = end;
    }
    return Math.min(safe, s.length);
}
