// ── API Fetch Wrapper ──
// All API calls centralized for error handling + ok/data unwrapping

/**
 * @param {string} path - API path (e.g. '/api/settings')
 * @param {RequestInit} opts - fetch options
 * @returns {Promise<any|null>} - data on success, null on failure
 */
export async function api(path, opts = {}) {
    try {
        const res = await fetch(path, opts);
        if (!res.ok) {
            console.warn(`[api] ${opts.method || 'GET'} ${path} → ${res.status}`);
            return null;
        }
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('json')) return null;
        const json = await res.json();
        // Phase 9.2 dual-response compat: { ok, data } or bare response
        if (json && typeof json === 'object' && 'ok' in json && 'data' in json) {
            if (!json.ok) {
                console.warn(`[api] ${path} → ok:false`, json.error || '');
                return null;
            }
            return json.data;
        }
        return json;
    } catch (e) {
        console.warn(`[api] ${path} failed:`, e.message);
        return null;
    }
}

/**
 * POST/PUT/DELETE JSON request
 */
export async function apiJson(path, method, body) {
    return api(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * fire-and-forget: ignores result
 */
export function apiFire(path, method = 'POST', body) {
    const opts = { method };
    if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }
    fetch(path, opts).catch(() => { });
}
