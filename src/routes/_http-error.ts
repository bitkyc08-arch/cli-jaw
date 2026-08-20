export interface HttpishError {
    statusCode?: number;
    code?: string | number;
    message?: string;
    /** Machine-readable context for the caller, e.g. the roots a refused path could have used. */
    detail?: Record<string, unknown>;
}

export function isHttpishError(e: unknown): e is HttpishError {
    return typeof e === 'object' && e !== null
        && ('statusCode' in e || 'code' in e || 'message' in e);
}

export function httpStatus(e: unknown, fallback: number): number {
    if (isHttpishError(e) && typeof e.statusCode === 'number') return e.statusCode;
    return fallback;
}

export function httpCode(e: unknown): string | number | undefined {
    if (isHttpishError(e)) return e.code;
    return undefined;
}

/**
 * The actionable half of an error. A refusal that names only its reason leaves
 * the caller — usually an agent that could move the file and retry — with
 * nowhere to go (#404).
 */
export function httpDetail(e: unknown): Record<string, unknown> | undefined {
    if (typeof e === 'object' && e !== null && 'detail' in e) {
        const d = (e as { detail?: unknown }).detail;
        if (d && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>;
    }
    return undefined;
}
