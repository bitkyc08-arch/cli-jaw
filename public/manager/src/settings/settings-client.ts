import type { SettingsClient } from './types';

const TIMEOUT_MS = 8000;

export class SettingsRequestError extends Error {
    method: string;
    path: string;
    status: number;
    detail: string;
    constructor(method: string, path: string, status: number, detail: string) {
        super(`${method} ${path} → ${status}: ${detail}`);
        this.name = 'SettingsRequestError';
        this.method = method;
        this.path = path;
        this.status = status;
        this.detail = detail;
    }
}

export function buildBaseUrl(port: number): string {
    return `/i/${port}`;
}

export function createSettingsClient(port: number): SettingsClient {
    const base = buildBaseUrl(port);
    const headers: HeadersInit = { 'content-type': 'application/json' };

    async function request<T>(
        method: string,
        path: string,
        body?: unknown,
        init?: RequestInit,
    ): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const fetchInit: RequestInit = {
                method,
                headers,
                signal: init?.signal || controller.signal,
                ...init,
            };
            if (body !== undefined) fetchInit.body = JSON.stringify(body);
            const response = await fetch(`${base}${path}`, fetchInit);
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new SettingsRequestError(method, path, response.status, detail);
            }
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                return (await response.json()) as T;
            }
            const detail = await response.text().catch(() => '');
            throw new SettingsRequestError(
                method,
                path,
                response.status,
                `expected JSON, received ${ct || 'unknown content-type'}: ${detail.slice(0, 120)}`,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        get: (path, init) => request('GET', path, undefined, init),
        put: (path, body, init) => request('PUT', path, body, init),
        post: (path, body, init) => request('POST', path, body, init),
        delete: (path, init) => request('DELETE', path, undefined, init),
    };
}
