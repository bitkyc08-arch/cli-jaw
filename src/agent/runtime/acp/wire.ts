/** ACP v1 single-envelope subset. Null and unsafe numeric IDs fail closed. */
export type RpcId = string | number;
export type RpcFrame =
    | { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown }
    | { jsonrpc: '2.0'; method: string; params?: unknown }
    | { jsonrpc: '2.0'; id: RpcId; result: unknown }
    | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } };

export function decodeFrame(line: string): RpcFrame {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error('acp_invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('acp_invalid_frame');
    const x = value as Record<string, unknown>;
    if (x['jsonrpc'] !== '2.0') throw new Error('acp_invalid_version');
    const hasId = Object.hasOwn(x, 'id');
    const id = x['id'];
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
    if (hasId && !validId) throw new Error('acp_invalid_id');
    if (Object.hasOwn(x, 'method')) {
        const method = x['method'];
        if (typeof method !== 'string' || !method || 'result' in x || 'error' in x) throw new Error('acp_invalid_method');
        const params = Object.hasOwn(x, 'params') ? { params: x['params'] } : {};
        if (hasId && validId) return { jsonrpc: '2.0', id, method, ...params };
        return { jsonrpc: '2.0', method, ...params };
    }
    if (!hasId || !validId || Object.hasOwn(x, 'result') === Object.hasOwn(x, 'error')) {
        throw new Error('acp_invalid_response');
    }
    if ('error' in x) {
        const raw = x['error'];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('acp_invalid_error');
        const e = raw as Record<string, unknown>;
        const code = e['code'];
        const message = e['message'];
        if (typeof code !== 'number' || !Number.isSafeInteger(code) || typeof message !== 'string') {
            throw new Error('acp_invalid_error');
        }
        return { jsonrpc: '2.0', id, error: { code, message,
            ...(Object.hasOwn(e, 'data') ? { data: e['data'] } : {}) } };
    }
    return { jsonrpc: '2.0', id, result: x['result'] };
}
