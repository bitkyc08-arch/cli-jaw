/**
 * FNV-1a 32-bit. Cheap, dependency-free, and good enough for cache/dedupe keys
 * where the alternative is embedding a full copy of the hashed text.
 * t3code uses the same function for its highlight cache keys
 * (apps/web/src/components/ChatMarkdown.tsx:307).
 */
export function fnv1a32(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}
