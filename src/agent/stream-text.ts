import { StringDecoder } from 'node:string_decoder';

/**
 * Chunk-boundary-safe text reading for child process streams (#372).
 *
 * A UTF-8 code point can be split across arbitrary stream chunks, so decoding each
 * Buffer independently with `chunk.toString()` corrupts Korean/CJK/emoji output and
 * can break NDJSON payloads mid-parse. Every standard child stream routes through
 * one reader per stream instead.
 *
 * Two rules matter and are easy to get wrong:
 *   1. Never share a reader between stdout and stderr — they are independent byte
 *      streams and interleaving their decoder state produces garbage.
 *   2. `end()` must run BEFORE the final pending line is dispatched, or the residual
 *      bytes of the last code point can never reach that line.
 */
export type TextStreamReader = {
    /** Decode a chunk. Strings pass through unchanged for already-decoded callers. */
    write(chunk: Buffer | string): string;
    /** Flush the decoder residual exactly once; later calls return ''. */
    end(): string;
};

export function createTextStreamReader(): TextStreamReader {
    const decoder = new StringDecoder('utf8');
    let ended = false;
    return {
        write(chunk) {
            if (typeof chunk === 'string') return chunk;
            if (ended) return '';
            return decoder.write(chunk);
        },
        end() {
            if (ended) return '';
            ended = true;
            return decoder.end();
        },
    };
}

/**
 * Clamp a string to `max` UTF-16 code units without splitting a surrogate pair.
 *
 * A naive `slice` can cut between a high and low surrogate and leave a lone
 * half-character at the boundary, which is exactly the corruption this module exists
 * to prevent.
 */
export function sliceWithoutSplittingSurrogate(text: string, max: number): string {
    if (max <= 0) return '';
    if (text.length <= max) return text;
    const code = text.charCodeAt(max - 1);
    const endsOnHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    return text.slice(0, endsOnHighSurrogate ? max - 1 : max);
}

