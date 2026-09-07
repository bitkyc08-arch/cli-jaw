import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimePrompt } from './session.js';

const MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const PER_IMAGE = 5 * 1024 * 1024;
const TOTAL = 10 * 1024 * 1024;

/** In-memory conversion only; upload staging and decoding remain caller-owned. */
export function makeClaudeUserMessage(prompt: RuntimePrompt): SDKUserMessage {
    if (typeof prompt.text !== 'string' || Buffer.byteLength(prompt.text, 'utf8') > 1024 * 1024) {
        throw new Error('Claude prompt too large or invalid');
    }
    const images = prompt.images ?? [];
    if (!Array.isArray(images) || images.length > 4) throw new Error('Too many or invalid Claude images');
    const content: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text: prompt.text }];
    let total = 0;
    for (const image of images) {
        const mime = MIMES.find(value => value === image?.mimeType);
        if (!mime || typeof image.data !== 'string' || !image.data.length
            || image.data.length > Math.ceil(PER_IMAGE / 3) * 4 || image.data.length % 4 !== 0) {
            throw new Error('Invalid Claude image');
        }
        const bytes = Buffer.from(image.data, 'base64');
        total += bytes.length;
        // Round-tripping rejects whitespace, invalid characters, padding and nonzero pad bits.
        if (!bytes.length || bytes.length > PER_IMAGE || total > TOTAL
            || bytes.toString('base64') !== image.data || !matchesImageSignature(bytes, mime)) {
            throw new Error('Invalid Claude image bytes');
        }
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: image.data } });
    }
    return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
}

/** Type signature checks, not a full decoder or a malware safety claim. */
function matchesImageSignature(bytes: Buffer, mime: typeof MIMES[number]): boolean {
    const starts = (magic: string) => bytes.subarray(0, magic.length).equals(Buffer.from(magic));
    if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (mime === 'image/gif') return starts('GIF87a') || starts('GIF89a');
    return starts('RIFF') && bytes.length >= 12 && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
}
