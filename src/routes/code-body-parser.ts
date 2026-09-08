import { json, type RequestHandler } from 'express';

export const CODE_PROMPT_MAX_BYTES = 1_048_576;
export const CODE_JSON_FRAMING_BYTES = 4_096;
// A decoded ASCII byte may occupy six JSON bytes (\\u0061); include key/framing space.
export const CODE_JSON_MAX_BYTES = 6 * CODE_PROMPT_MAX_BYTES + CODE_JSON_FRAMING_BYTES;

function isCodePath(path: string): boolean {
    return /^\/api\/code(?:\/|$)/i.test(path);
}

export function createWorkerApiJsonParser(): RequestHandler {
    const code = json({ limit: CODE_JSON_MAX_BYTES });
    const fallback = json({ limit: '1mb' });
    return (req, res, next) => (isCodePath(req.path) ? code : fallback)(req, res, next);
}

export function createManagerApiJsonParser(): RequestHandler {
    const code = json({ limit: CODE_JSON_MAX_BYTES });
    const fallback = json({ limit: '64kb' });
    return (req, res, next) => {
        if (isCodePath(req.path)) return code(req, res, next);
        // The proxy forwards the untouched stream; browser/design routes own their parsers.
        if (/^\/i\/\d+(?:\/|$)/.test(req.path)) return next();
        if (req.path.startsWith('/api/manager/embedded-browser/commands/')) return next();
        if (req.method === 'PUT' && /^\/api\/dashboard\/design\/pages\/[^/]+\/files\//.test(req.path)) return next();
        return fallback(req, res, next);
    };
}
