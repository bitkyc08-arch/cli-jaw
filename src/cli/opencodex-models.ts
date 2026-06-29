import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_REGISTRY, CODEX_MODEL_CHOICES } from './registry.js';

type CachedOpenCodexModels = {
    fetchedAt: number;
    models: string[];
};

const OPENCODEX_DIR = process.env['CLI_JAW_OPENCODEX_DIR'] || join(homedir(), '.opencodex');
const OPENCODEX_RUNTIME_PORT_PATH = join(OPENCODEX_DIR, 'runtime-port.json');
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

async function readOpenCodexPort(): Promise<number | null> {
    try {
        const raw = JSON.parse(await readFile(OPENCODEX_RUNTIME_PORT_PATH, 'utf8')) as Record<string, unknown>;
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

export async function resolveOpenCodexCodexModels(): Promise<string[]> {
    const now = Date.now();
    if (cachedOpenCodexModels && now - cachedOpenCodexModels.fetchedAt < CACHE_TTL_MS) {
        return [...cachedOpenCodexModels.models];
    }

    const port = await readOpenCodexPort();
    if (!port) return defaultCodexModels();

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetchJson(`${baseUrl}/healthz`, HEALTH_TIMEOUT_MS);
    if (!health || typeof health !== 'object' || Array.isArray(health)
        || (health as Record<string, unknown>)['status'] !== 'ok') {
        return defaultCodexModels();
    }

    const modelsPayload = await fetchJson(`${baseUrl}/v1/models`, MODELS_TIMEOUT_MS);
    const models = parseModelIds(modelsPayload);
    const resolved = models.length > 0 ? models : defaultCodexModels();
    cachedOpenCodexModels = { fetchedAt: now, models: resolved };
    return [...resolved];
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
