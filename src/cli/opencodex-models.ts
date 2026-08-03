import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_REGISTRY, CODEX_EFFORT_CHOICES, CODEX_MODEL_CHOICES } from './registry.js';

/**
 * One model as advertised by opencodex `GET /v1/models`.
 *
 * `efforts` is the per-model reasoning-effort set. It is authoritative and may
 * be EMPTY: opencodex omits `supports_reasoning_effort` for routed models that
 * take no effort at all (e.g. `anthropic/claude-fable-5`). An empty set means
 * "do not offer an effort", not "fall back to the static list" — the value is
 * forwarded to the wire as `-c model_reasoning_effort=` (src/agent/args.ts).
 */
export interface OpenCodexModelEntry {
    id: string;
    efforts: string[];
    defaultEffort?: string;
}

export interface OpenCodexModelsResult {
    models: string[];
    entries: OpenCodexModelEntry[];
    source: 'opencodex' | 'static';
}

type CachedOpenCodexModels = {
    fetchedAt: number;
    models: string[];
    entries: OpenCodexModelEntry[];
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

/**
 * Static fallback entries for an inactive opencodex. Every model gets the
 * registry's static effort list so the picker keeps working offline.
 */
function defaultCodexEntries(): OpenCodexModelEntry[] {
    return CODEX_MODEL_CHOICES.map((id) => ({ id, efforts: [...CODEX_EFFORT_CHOICES] }));
}

function staticResult(): OpenCodexModelsResult {
    return { models: defaultCodexModels(), entries: defaultCodexEntries(), source: 'static' };
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

/**
 * Parse the `/v1/models` payload into id + per-model effort metadata.
 *
 * Effort resolution mirrors the opencodex wire shape:
 *   - `reasoning_efforts[]` is a list of `{ value, label, default? }`.
 *   - `supports_reasoning_effort === false` hard-disables efforts.
 *   - the per-model default comes from `reasoning_effort`, falling back to the
 *     entry flagged `default: true`.
 */
export function parseModelEntries(payload: unknown): OpenCodexModelEntry[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const data = (payload as Record<string, unknown>)['data'];
    if (!Array.isArray(data)) return [];

    const seen = new Set<string>();
    const entries: OpenCodexModelEntry[] = [];
    for (const raw of data) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const record = raw as Record<string, unknown>;
        const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const levels = Array.isArray(record['reasoning_efforts']) ? record['reasoning_efforts'] : [];
        const efforts = record['supports_reasoning_effort'] === false
            ? []
            : dedupeModels(levels
                .map((level) => level && typeof level === 'object' && !Array.isArray(level)
                    ? (level as Record<string, unknown>)['value']
                    : null)
                .filter((value): value is string => typeof value === 'string'));

        const declared = typeof record['reasoning_effort'] === 'string' ? record['reasoning_effort'] : '';
        const flagged = levels
            .filter((level): level is Record<string, unknown> =>
                Boolean(level) && typeof level === 'object' && !Array.isArray(level))
            .find((level) => level['default'] === true);
        const flaggedValue = typeof flagged?.['value'] === 'string' ? flagged['value'] : '';
        const defaultEffort = efforts.includes(declared)
            ? declared
            : efforts.includes(flaggedValue) ? flaggedValue : '';

        entries.push(defaultEffort ? { id, efforts, defaultEffort } : { id, efforts });
    }
    return entries;
}

function parseModelIds(payload: unknown): string[] {
    return parseModelEntries(payload).map((entry) => entry.id);
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
            entries: cachedOpenCodexModels.entries.map((entry) => ({ ...entry, efforts: [...entry.efforts] })),
            source: cachedOpenCodexModels.source,
        };
    }

    const port = await readOpenCodexPort();
    if (!port) return staticResult();

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetchJson(`${baseUrl}/healthz`, HEALTH_TIMEOUT_MS);
    if (!health || typeof health !== 'object' || Array.isArray(health)
        || (health as Record<string, unknown>)['status'] !== 'ok'
        || (health as Record<string, unknown>)['service'] !== 'opencodex') {
        return staticResult();
    }

    const modelsPayload = await fetchJson(`${baseUrl}/v1/models`, MODELS_TIMEOUT_MS);
    const parsed = parseModelEntries(modelsPayload);
    const live = parsed.length > 0;
    const entries = live ? parsed : defaultCodexEntries();
    const resolved = entries.map((entry) => entry.id);
    const source: OpenCodexModelsResult['source'] = live ? 'opencodex' : 'static';
    cachedOpenCodexModels = { fetchedAt: now, models: resolved, entries, source };
    return {
        models: [...resolved],
        entries: entries.map((entry) => ({ ...entry, efforts: [...entry.efforts] })),
        source,
    };
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
