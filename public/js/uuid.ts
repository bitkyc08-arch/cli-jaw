// ── UUID Utility ──
/**
 * Secure-context-safe UUID v4 generator.
 * crypto.randomUUID() requires Secure Context (HTTPS / localhost).
 * Fallback chain: randomUUID → getRandomValues (RFC 4122) → Math.random.
 * Math.random tier is NOT cryptographically secure — used only for UI element IDs.
 */
export function generateId(): string {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
    if (typeof c?.getRandomValues !== 'function') {
        // Last resort: Math.random (never reached in modern browsers)
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
            const r = (Math.random() * 16) | 0;
            return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
