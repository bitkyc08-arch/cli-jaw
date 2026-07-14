const TARGET_BYTES = 10 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export const TOOL_DETAIL_SCENARIOS = {
    unavailable: { status: 404, error: 'trace_event_not_found' },
    gone: { status: 410, error: 'trace_payload_gone' },
    revisionChanged: { status: 409, error: 'trace_payload_revision_changed' },
} as const;

function seededWord(seed: number): string {
    let value = seed >>> 0;
    let out = '';
    for (let index = 0; index < 16; index += 1) {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        out += String.fromCharCode(97 + (value % 26));
    }
    return out;
}

export function generateToolDetail10Mb(targetBytes = TARGET_BYTES): string {
    const parts: string[] = [];
    let bytes = 0;
    for (let row = 0; bytes < targetBytes; row += 1) {
        const record = row % 4 === 0
            ? `\x1b[3${row % 8}m색상-${row} 한글🙂 ${seededWord(row)}\x1b[0m\n`
            : row % 4 === 1
                ? `${JSON.stringify({ row, ok: true, message: `데이터🙂-${seededWord(row)}`, values: [row, row + 1] })}\n`
                : row % 4 === 2
                    ? `@@ -${row},2 +${row + 1},2 @@\n-${seededWord(row)}\n+${seededWord(row + 1)}🙂\n`
                    : `${row}: ${seededWord(row).repeat(256)} 한글🙂 end\n`;
        parts.push(record);
        bytes += Buffer.byteLength(record, 'utf8');
    }
    return parts.join('');
}

function continuationByte(byte: number): boolean { return (byte & 0xc0) === 0x80; }

export function sliceToolDetailUtf8(text: string, requestedOffset: number, limit: number) {
    const source = Buffer.from(text, 'utf8');
    let actualStart = Math.min(Math.max(0, requestedOffset), source.byteLength);
    while (actualStart < source.byteLength && continuationByte(source[actualStart]!)) actualStart += 1;
    let actualEndExclusive = Math.min(source.byteLength, actualStart + limit);
    while (actualEndExclusive > actualStart && actualEndExclusive < source.byteLength
        && continuationByte(source[actualEndExclusive]!)) actualEndExclusive -= 1;
    const chunk = source.subarray(actualStart, actualEndExclusive);
    return {
        requestedOffset,
        actualStart,
        actualEndExclusive,
        nextOffset: actualEndExclusive < source.byteLength ? actualEndExclusive : null,
        text: decoder.decode(chunk),
        totalBytes: source.byteLength,
        utf8Adjusted: actualStart !== requestedOffset,
    };
}

export function fixtureLineAtByteOffset(text: string, offset: number): number {
    const bytes = Buffer.from(text, 'utf8');
    let line = 1;
    for (let index = 0; index < Math.min(offset, bytes.byteLength); index += 1) if (bytes[index] === 0x0a) line += 1;
    return line;
}
