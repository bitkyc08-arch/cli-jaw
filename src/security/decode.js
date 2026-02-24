// ─── Security: Filename Decode ───────────────────────
// Phase 9.1 — percent-encoding 안전 디코딩

/**
 * x-filename 헤더 등의 percent-encoded 파일명을 안전하게 디코딩
 * @param {string|null|undefined} rawHeader
 * @returns {string} decoded filename
 * @throws 400 filename_too_long / invalid_percent_encoding
 */
export function decodeFilenameSafe(rawHeader) {
    const raw = String(rawHeader || '').trim();
    if (!raw) return 'upload.bin';
    if (raw.length > 200) {
        throw Object.assign(new Error('filename_too_long'), { statusCode: 400 });
    }
    try {
        return decodeURIComponent(raw);
    } catch {
        throw Object.assign(new Error('invalid_percent_encoding'), { statusCode: 400 });
    }
}
