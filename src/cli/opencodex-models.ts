import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_REGISTRY, CODEX_MODEL_CHOICES } from './registry.js';

export interface OpenCodexModelsResult {
    models: string[];
    source: 'opencodex' | 'static';
}

type CachedOpenCodexModels = {
    fetchedAt: number;
    models: string[];
    source: OpenCodexModelsResult['source'];
};

const CACHE_TTL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 350;
const MODELS_TIMEOUT_MS = 900;

let cachedOpenCodexModels: CachedOpenCodexModels | null = null;

function dedupeModels(models: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const model of models) {
        const trimmed = model.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function defaultCodexModels(): string[] {
    return [...CODEX_MODEL_CHOICES];
}

function isCodexCli(cli: string): boolean {
    return cli === 'codex' || cli === 'codex-app';
}

function openCodexDir(): string {
    return process.env['CLI_JAW_OPENCODEX_DIR'] || join(homedir(), '.opencodex');
}

function openCodexRuntimePortPath(): string {
    return join(openCodexDir(), 'runtime-port.json');
}

async function readOpenCodexPort(): Promise<number | null> {
    try {
        const raw = JSON.parse(await readFile(openCodexRuntimePortPath(), 'utf8')) as Record<string, unknown>;
        const port = raw['port'];
        return Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535
            ? port as number
            : null;
    } catch {
        return null;
    }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
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

function parseModelIds(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const data = (payload as Record<string, unknown>)['data'];
    if (!Array.isArray(data)) return [];
    return dedupeModels(data
        .map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)['id']
            : null)
        .filter((id): id is string => typeof id === 'string'));
}

/**
 * Probe an arbitrary base URL only when its origin identifies as opencodex.
 * Pi profile endpoints conventionally include `/v1`, so models are read from
 * `<base>/models` while identity is checked at `<origin>/healthz`.
 */
export async function probeOpenCodexEndpointModels(endpoint: string, timeoutMs = 1500): Promise<string[] | null> {
    const base = endpoint.trim().replace(/\/+$/, '');
    if (!base) return null;

    let origin: string;
    try {
        origin = new URL(base).origin;
    } catch {
        return null;
    }

    const health = await fetchJson(`${origin}/healthz`, Math.min(timeoutMs, HEALTH_TIMEOUT_MS * 3));
    if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
    const fingerprint = health as Record<string, unknown>;
    if (fingerprint['status'] !== 'ok' || fingerprint['service'] !== 'opencodex') return null;

    const models = parseModelIds(await fetchJson(`${base}/models`, timeoutMs));
    return models.length > 0 ? models : null;
}

export function applyCodexModelsToChoices(
    choicesByCli: Record<string, string[]>,
    codexModels: readonly string[],
): Record<string, string[]> {
    const models = dedupeModels([...codexModels]);
    choicesByCli['codex'] = [...models];
    choicesByCli['codex-app'] = [...models];
    const aiE = choicesByCli['ai-e'];
    if (aiE) {
        const nonCodex = aiE.filter((model) => !CODEX_MODEL_CHOICES.includes(model));
        choicesByCli['ai-e'] = dedupeModels([...nonCodex, ...models]);
    }
    return choicesByCli;
}

export async function resolveOpenCodexCodexModelsDetailed(): Promise<OpenCodexModelsResult> {
    const now = Date.now();
    if (cachedOpenCodexModels && now - cachedOpenCodexModels.fetchedAt < CACHE_TTL_MS) {
        return {
            models: [...cachedOpenCodexModels.models],
            source: cachedOpenCodexModels.source,
        };
    }

    const port = await readOpenCodexPort();
    if (!port) return { models: defaultCodexModels(), source: 'static' };

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetchJson(`${baseUrl}/healthz`, HEALTH_TIMEOUT_MS);
    if (!health || typeof health !== 'object' || Array.isArray(health)
        || (health as Record<string, unknown>)['status'] !== 'ok'
        || (health as Record<string, unknown>)['service'] !== 'opencodex') {
        return { models: defaultCodexModels(), source: 'static' };
    }

    const modelsPayload = await fetchJson(`${baseUrl}/v1/models`, MODELS_TIMEOUT_MS);
    const models = parseModelIds(modelsPayload);
    const resolved = models.length > 0 ? models : defaultCodexModels();
    const source: OpenCodexModelsResult['source'] = models.length > 0 ? 'opencodex' : 'static';
    cachedOpenCodexModels = { fetchedAt: now, models: resolved, source };
    return { models: [...resolved], source };
}

export async function resolveOpenCodexCodexModels(): Promise<string[]> {
    return (await resolveOpenCodexCodexModelsDetailed()).models;
}

export async function resolveCliDefaultModel(cli: string): Promise<string> {
    const fallback = CLI_REGISTRY[cli as keyof typeof CLI_REGISTRY]?.defaultModel || 'default';
    if (!isCodexCli(cli)) return fallback;
    const models = await resolveOpenCodexCodexModels();
    return models[0] || fallback;
}

/** @internal exported for unit tests */
export function resetOpenCodexModelCacheForTest(): void {
    cachedOpenCodexModels = null;
}
