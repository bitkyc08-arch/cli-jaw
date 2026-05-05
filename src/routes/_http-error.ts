export interface HttpishError { statusCode?: number; code?: string | number; message?: string }

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
