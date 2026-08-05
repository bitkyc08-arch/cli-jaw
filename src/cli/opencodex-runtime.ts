import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HEALTH_TIMEOUT_MS = 350;

export type OpenCodexRuntimeStatus = {
    state: 'healthy' | 'missing-port' | 'unhealthy';
    port: number | null;
    baseUrl: string | null;
    version: string | null;
};

export type OpenCodexExecutionCoupling =
    | 'configured-and-healthy'
    | 'config-mismatch'
    | 'proxy-unavailable'
    | 'not-configured';

export interface OpenCodexRuntimeOptions {
    directory?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

function openCodexDirectory(override?: string): string {
    return override || process.env['CLI_JAW_OPENCODEX_DIR'] || join(homedir(), '.opencodex');
}

async function fetchJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) return null;
        return await response.json() as unknown;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function resolveOpenCodexRuntime(options: OpenCodexRuntimeOptions = {}): Promise<OpenCodexRuntimeStatus> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(join(openCodexDirectory(options.directory), 'runtime-port.json'), 'utf8')) as unknown;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : null;
        return {
            state: code === 'ENOENT' ? 'missing-port' : 'unhealthy',
            port: null,
            baseUrl: null,
            version: null,
        };
    }

    const port = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)['port']
        : null;
    if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
        return { state: 'unhealthy', port: null, baseUrl: null, version: null };
    }

    const resolvedPort = port as number;
    const baseUrl = `http://127.0.0.1:${resolvedPort}`;
    const health = await fetchJson(
        `${baseUrl}/healthz`,
        options.timeoutMs ?? HEALTH_TIMEOUT_MS,
        options.fetchImpl ?? fetch,
    );
    if (!health || typeof health !== 'object' || Array.isArray(health)) {
        return { state: 'unhealthy', port: resolvedPort, baseUrl, version: null };
    }
    const fingerprint = health as Record<string, unknown>;
    if (fingerprint['status'] !== 'ok' || fingerprint['service'] !== 'opencodex') {
        return { state: 'unhealthy', port: resolvedPort, baseUrl, version: null };
    }
    return {
        state: 'healthy',
        port: resolvedPort,
        baseUrl,
        version: typeof fingerprint['version'] === 'string' ? fingerprint['version'] : null,
    };
}

export function normalizeOpenAiBaseUrl(url: string): string {
    return url.trim().replace(/\/$/, '');
}

export function diagnoseOpenCodexExecution(
    configuredUrl: string | null,
    runtime: OpenCodexRuntimeStatus,
): OpenCodexExecutionCoupling {
    if (!configuredUrl) return 'not-configured';
    const normalized = normalizeOpenAiBaseUrl(configuredUrl);
    if (runtime.state === 'healthy' && runtime.baseUrl) {
        return normalized === `${runtime.baseUrl}/v1`
            ? 'configured-and-healthy'
            : 'config-mismatch';
    }
    return /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(normalized)
        ? 'proxy-unavailable'
        : 'config-mismatch';
}
