/**
 * src/browser/image-size.ts — read pixel dimensions from a capture file.
 *
 * Kept out of actions.ts so it can be tested without the CDP layer.
 *
 * This exists because the bounds check needs the frame the model actually saw.
 * The requested clip is not that frame: Playwright trims a clip to the viewport
 * before capture, and the route accepts an array clip whose `.width` is
 * undefined — and comparing a number against `undefined` is always false, so
 * such a bound looks present while checking nothing.
 */
import fs from 'fs';

/**
 * Returns null when the size cannot be read. Callers must fail closed on null:
 * a plausible-looking default would be worse than admitting it is unknown.
 */
export function imageSize(filepath: string): { width: number; height: number } | null {
    let head: Buffer;
    try {
        const fd = fs.openSync(filepath, 'r');
        try {
            const buffer = Buffer.alloc(65536);
            const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
            head = buffer.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    } catch { return null; }

    // PNG: 8-byte signature, then an IHDR chunk whose data begins at byte 16.
    if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
        return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }

    // JPEG: walk the segment chain to a start-of-frame marker.
    if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
        let i = 2;
        while (i + 9 < head.length) {
            if (head[i] !== 0xff) { i += 1; continue; }
            const marker = head[i + 1] as number;
            // Standalone markers carry no length field.
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const length = head.readUInt16BE(i + 2);
            if (length < 2) return null; // malformed chain
            // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
            }
            i += 2 + length;
        }
    }
    return null;
}

