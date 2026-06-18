import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { isMap, parseDocument } from 'yaml';

export type JwcModelProvider = {
    id: string;
    models: string[];
    efforts: string[];
};

export type JwcModelOptions = {
    providers: JwcModelProvider[];
    defaultProvider: string;
    defaultModel: string;
    usageOrder?: string[];
    degraded?: boolean;
    error?: string;
};

export type JwcModelRole = {
    provider: string;
    model: string;
    thinkingLevel?: string;
};

export type JwcThinkingLevel = 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type JwcModelAssignmentRole = 'default' | 'executor_ext' | 'executor' | 'architect' | 'planner' | 'critic';

export type JwcModelAssignmentSettingsPath = 'modelRoles' | 'task.agentModelOverrides';

export type JwcModelAssignment = {
    role: JwcModelAssignmentRole;
    tag: string;
    name: string;
    settingsPath: JwcModelAssignmentSettingsPath;
    modelId?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
};

export type JwcModelPresetEntry = {
    name: string;
    best?: string;
    cheap?: string;
};

export type JwcBuiltinModelProfile = {
    name: string;
    source: 'builtin';
};

export type JwcModelProfilePresetInfo = {
    defaultProfile?: string;
    taskPresets: JwcModelPresetEntry[];
    builtinProfiles: JwcBuiltinModelProfile[];
    applyAvailable: false;
    applyReason: string;
};

export type JwcModelUsageInfo = {
    usageOrder: string[];
};

export const JWC_THINKING_LEVELS: JwcThinkingLevel[] = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const JWC_MODEL_CACHE_SCHEMA_VERSION = 3;

const JWC_THINKING_SUFFIXES = new Set(['off', 'min', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const JWC_MODEL_ASSIGNMENT_TARGET_IDS: JwcModelAssignmentRole[] = [
    'default',
    'executor_ext',
    'executor',
    'architect',
    'planner',
    'critic',
];

export const JWC_MODEL_ASSIGNMENT_TARGETS: Record<JwcModelAssignmentRole, {
    tag: string;
    name: string;
    settingsPath: JwcModelAssignmentSettingsPath;
}> = {
    default: { tag: 'DEFAULT', name: 'Default', settingsPath: 'modelRoles' },
    executor_ext: { tag: 'EXECUTOR_EXT', name: 'External Executor', settingsPath: 'task.agentModelOverrides' },
    executor: { tag: 'EXECUTOR', name: 'Executor', settingsPath: 'task.agentModelOverrides' },
    architect: { tag: 'ARCHITECT', name: 'Architect', settingsPath: 'task.agentModelOverrides' },
    planner: { tag: 'PLANNER', name: 'Planner', settingsPath: 'task.agentModelOverrides' },
    critic: { tag: 'CRITIC', name: 'Critic', settingsPath: 'task.agentModelOverrides' },
};

export const JWC_PROVIDER_MODEL_DEFAULTS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
    'openai-codex': ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    xai: ['grok-build', 'grok-composer-2.5-fast', 'grok-4.3'],
    cursor: ['composer-2.5', 'claude-sonnet-4-6', 'gpt-5.4'],
    'opencode-go': ['opencode-go/kimi-k2.6', 'opencode-go/glm-5.1'],
    google: ['gemini-3-flash-preview', 'gemini-2.5-pro'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    fireworks: ['accounts/fireworks/models/deepseek-v3'],
    groq: ['openai/gpt-oss-120b'],
};

export const JWC_PROVIDER_EFFORT_DEFAULTS: Record<string, string[]> = {
    anthropic: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
    'openai-codex': ['low', 'medium', 'high', 'xhigh'],
    xai: [],
    cursor: ['low', 'medium', 'high', 'xhigh'],
    'opencode-go': ['minimal', 'low', 'high', 'max'],
};

export const JWC_BUILTIN_MODEL_PROFILE_NAMES = [
    'custom-1',
    'custom-2',
    'custom-3',
    'custom-4',
    'opencode-go-eco',
    'opencode-go-standard',
    'opencode-go-pro',
    'codex-eco',
    'codex-standard',
    'codex-pro',
    'minimax-standard',
    'minimax-cn-standard',
    'kimi-standard',
    'glm-standard',
    'opencode-go-codex-eco',
    'opencode-go-codex-standard',
    'opencode-go-codex-pro',
] as const;

export const JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON =
    'Profile activation is delegated to JWC runtime because it validates credentials and supports rollback.';

export function resolveJwcAgentDir(): string {
    return process.env['CLI_JAW_JWC_AGENT_DIR'] || join(homedir(), '.jwc', 'agent');
}

export function isJwcModelAssignmentRole(value: string): value is JwcModelAssignmentRole {
    return JWC_MODEL_ASSIGNMENT_TARGET_IDS.includes(value as JwcModelAssignmentRole);
}

export function parseJwcModelRole(value: string | undefined): JwcModelRole | null {
    if (!value) return null;
    const trimmed = value.trim();
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx <= 0) return null;
    const provider = trimmed.slice(0, slashIdx);
    let model = trimmed.slice(slashIdx + 1);
    let thinkingLevel: string | undefined;
    const colonIdx = model.lastIndexOf(':');
    if (colonIdx !== -1) {
        const suffix = model.slice(colonIdx + 1);
        if (JWC_THINKING_SUFFIXES.has(suffix)) {
            thinkingLevel = suffix;
            model = model.slice(0, colonIdx);
        }
    }
    if (!provider || !model) return null;
    return { provider, model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function normalizeJwcThinkingLevel(value: unknown): JwcThinkingLevel | undefined {
    if (value === null || value === undefined) return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === 'inherit') return undefined;
    if (normalized === 'min') return 'minimal';
    return JWC_THINKING_LEVELS.includes(normalized as JwcThinkingLevel)
        ? normalized as JwcThinkingLevel
        : undefined;
}

export function buildJwcModelRole(provider: string, model: string, thinkingLevel?: unknown): string {
    const cleanProvider = provider.trim();
    const cleanModel = model.trim();
    if (!cleanProvider || !cleanModel) throw new Error('provider and model required');
    const normalizedThinking = normalizeJwcThinkingLevel(thinkingLevel);
    return normalizedThinking
        ? `${cleanProvider}/${cleanModel}:${normalizedThinking}`
        : `${cleanProvider}/${cleanModel}`;
}

export async function readJwcDefaultModelRole(agentDir = resolveJwcAgentDir()): Promise<string | undefined> {
    try {
        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');
        const doc = parseDocument(content, { prettyErrors: false });
        const modelRoles = doc.get('modelRoles');
        if (!modelRoles || typeof modelRoles !== 'object' || !('get' in modelRoles)) return undefined;
        const value = (modelRoles as { get(key: string): unknown }).get('default');
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
        return undefined;
    }
}

export async function writeJwcDefaultModelRole(modelRole: string, agentDir = resolveJwcAgentDir()): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    const configPath = join(agentDir, 'config.yml');
    let content = '';
    try {
        content = await readFile(configPath, 'utf8');
    } catch {
        content = '';
    }
    const doc = parseDocument(content || '{}\n', { prettyErrors: false });
    doc.setIn(['modelRoles', 'default'], modelRole);
    if (isMap(doc.contents)) doc.contents.flow = false;
    const modelRoles = doc.get('modelRoles', true);
    if (isMap(modelRoles)) modelRoles.flow = false;
    await writeFile(configPath, doc.toString(), 'utf8');
}

async function readJwcConfigDocument(agentDir: string) {
    const configPath = join(agentDir, 'config.yml');
    let content = '';
    try {
        content = await readFile(configPath, 'utf8');
    } catch {
        content = '';
    }
    return {
        configPath,
        doc: parseDocument(content || '{}\n', { prettyErrors: false }),
    };
}

function setBlockStyleMaps(doc: ReturnType<typeof parseDocument>): void {
    if (isMap(doc.contents)) doc.contents.flow = false;
    const modelRoles = doc.get('modelRoles', true);
    if (isMap(modelRoles)) modelRoles.flow = false;
    const task = doc.get('task', true);
    if (isMap(task)) task.flow = false;
    const agentModelOverrides = doc.getIn(['task', 'agentModelOverrides'], true);
    if (isMap(agentModelOverrides)) agentModelOverrides.flow = false;
}

function modelRolePath(role: JwcModelAssignmentRole): Array<string> {
    const target = JWC_MODEL_ASSIGNMENT_TARGETS[role];
    return target.settingsPath === 'modelRoles'
        ? ['modelRoles', role]
        : ['task', 'agentModelOverrides', role];
}

function readStringAt(doc: ReturnType<typeof parseDocument>, path: Array<string>): string | undefined {
    const value = doc.getIn(path);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function readJwcModelAssignments(agentDir = resolveJwcAgentDir()): Promise<JwcModelAssignment[]> {
    try {
        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');
        const doc = parseDocument(content, { prettyErrors: false });
        return JWC_MODEL_ASSIGNMENT_TARGET_IDS.map(role => {
            const target = JWC_MODEL_ASSIGNMENT_TARGETS[role];
            const modelId = readStringAt(doc, modelRolePath(role));
            const parsed = parseJwcModelRole(modelId);
            return {
                role,
                tag: target.tag,
                name: target.name,
                settingsPath: target.settingsPath,
                ...(modelId ? { modelId } : {}),
                ...(parsed ? {
                    provider: parsed.provider,
                    model: parsed.model,
                    ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
                } : {}),
            };
        });
    } catch {
        return JWC_MODEL_ASSIGNMENT_TARGET_IDS.map(role => {
            const target = JWC_MODEL_ASSIGNMENT_TARGETS[role];
            return { role, tag: target.tag, name: target.name, settingsPath: target.settingsPath };
        });
    }
}

export async function writeJwcModelAssignment(
    role: JwcModelAssignmentRole,
    modelRole: string,
    agentDir = resolveJwcAgentDir(),
): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    const { configPath, doc } = await readJwcConfigDocument(agentDir);
    doc.setIn(modelRolePath(role), modelRole);
    setBlockStyleMaps(doc);
    await writeFile(configPath, doc.toString(), 'utf8');
}

export async function clearJwcModelAssignment(
    role: JwcModelAssignmentRole,
    agentDir = resolveJwcAgentDir(),
): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    const { configPath, doc } = await readJwcConfigDocument(agentDir);
    doc.deleteIn(modelRolePath(role));
    setBlockStyleMaps(doc);
    await writeFile(configPath, doc.toString(), 'utf8');
}

export async function resolveJwcModelAssignments(agentDir = resolveJwcAgentDir()): Promise<{
    roles: JwcModelAssignment[];
    activeModel: { scope: 'session'; note: string };
}> {
    const roles = await readJwcModelAssignments(agentDir);
    return {
        roles,
        activeModel: {
            scope: 'session',
            note: 'Role assignments do not mutate the active Code session model.',
        },
    };
}

function taskPresetEntries(raw: unknown): JwcModelPresetEntry[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw as Record<string, unknown>)
        .map(([name, value]) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            const record = value as Record<string, unknown>;
            const best = typeof record['best'] === 'string' && record['best'].trim() ? record['best'].trim() : undefined;
            const cheap = typeof record['cheap'] === 'string' && record['cheap'].trim() ? record['cheap'].trim() : undefined;
            return {
                name,
                ...(best ? { best } : {}),
                ...(cheap ? { cheap } : {}),
            };
        })
        .filter((entry): entry is JwcModelPresetEntry => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readJwcModelProfilePresetInfo(agentDir = resolveJwcAgentDir()): Promise<JwcModelProfilePresetInfo> {
    let defaultProfile: string | undefined;
    let taskPresets: JwcModelPresetEntry[] = [];
    try {
        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');
        const doc = parseDocument(content || '{}\n', { prettyErrors: false });
        const json = doc.toJSON() as Record<string, unknown> | null;
        const modelProfile = json?.['modelProfile'];
        if (modelProfile && typeof modelProfile === 'object' && !Array.isArray(modelProfile)) {
            const rawDefault = (modelProfile as Record<string, unknown>)['default'];
            if (typeof rawDefault === 'string' && rawDefault.trim()) defaultProfile = rawDefault.trim();
        }
        const task = json?.['task'];
        if (task && typeof task === 'object' && !Array.isArray(task)) {
            taskPresets = taskPresetEntries((task as Record<string, unknown>)['modelPresets']);
        }
    } catch {
        defaultProfile = undefined;
        taskPresets = [];
    }
    return {
        ...(defaultProfile ? { defaultProfile } : {}),
        taskPresets,
        builtinProfiles: JWC_BUILTIN_MODEL_PROFILE_NAMES.map(name => ({ name, source: 'builtin' })),
        applyAvailable: false,
        applyReason: JWC_MODEL_PROFILE_APPLY_DEFERRED_REASON,
    };
}

export function readJwcModelUsageOrder(agentDir = resolveJwcAgentDir()): string[] {
    let db: Database.Database | null = null;
    try {
        db = new Database(join(agentDir, 'agent.db'), { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT model_key FROM model_usage ORDER BY last_used_at DESC')
            .all() as Array<{ model_key?: unknown }>;
        return rows
            .map(row => row.model_key)
            .filter((modelKey): modelKey is string => typeof modelKey === 'string' && modelKey.length > 0);
    } catch {
        return [];
    } finally {
        db?.close();
    }
}

function modelIdsFromCacheJson(rawModels: unknown): string[] {
    let parsed: unknown;
    try {
        parsed = typeof rawModels === 'string' ? JSON.parse(rawModels) : rawModels;
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const modelIds: string[] = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const id = (entry as Record<string, unknown>)['id'];
        if (typeof id !== 'string') continue;
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        modelIds.push(trimmed);
    }
    return modelIds;
}

export function readJwcModelCache(agentDir = resolveJwcAgentDir()): Map<string, string[]> {
    let db: Database.Database | null = null;
    const catalog = new Map<string, string[]>();
    try {
        db = new Database(join(agentDir, 'models.db'), { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT provider_id, version, models FROM model_cache')
            .all() as Array<{ provider_id?: unknown; version?: unknown; models?: unknown }>;
        for (const row of rows) {
            if (typeof row.provider_id !== 'string' || row.provider_id.length === 0) continue;
            if (row.version !== JWC_MODEL_CACHE_SCHEMA_VERSION) continue;
            const modelIds = modelIdsFromCacheJson(row.models);
            if (modelIds.length > 0) catalog.set(row.provider_id, modelIds);
        }
    } catch {
        return new Map();
    } finally {
        db?.close();
    }
    return catalog;
}

function providerCatalogModels(provider: string, modelCatalog: Map<string, string[]>): string[] {
    const cached = modelCatalog.get(provider);
    return cached && cached.length > 0
        ? cached
        : JWC_PROVIDER_MODEL_DEFAULTS[provider] ?? [];
}

export function filterJwcModelUsageOrder(
    usageOrder: string[],
    providers: Pick<JwcModelProvider, 'id' | 'models'>[],
): string[] {
    const available = new Set<string>();
    for (const provider of providers) {
        for (const model of provider.models) {
            available.add(`${provider.id}/${model}`);
        }
    }
    const seen = new Set<string>();
    return usageOrder.filter(modelKey => {
        if (!available.has(modelKey) || seen.has(modelKey)) return false;
        seen.add(modelKey);
        return true;
    });
}

function sortModelsForProvider(provider: string, models: string[], defaultModelRole: string | undefined, usageOrder: string[]): string[] {
    const parsedDefault = parseJwcModelRole(defaultModelRole);
    const usageRank = new Map<string, number>();
    usageOrder.forEach((modelKey, index) => {
        if (!usageRank.has(modelKey)) usageRank.set(modelKey, index);
    });
    const staticRank = new Map<string, number>();
    models.forEach((model, index) => staticRank.set(model, index));

    return [...models].sort((a, b) => {
        const aIsDefault = parsedDefault?.provider === provider && parsedDefault.model === a;
        const bIsDefault = parsedDefault?.provider === provider && parsedDefault.model === b;
        if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;

        const aUsage = usageRank.get(`${provider}/${a}`) ?? Number.MAX_SAFE_INTEGER;
        const bUsage = usageRank.get(`${provider}/${b}`) ?? Number.MAX_SAFE_INTEGER;
        if (aUsage !== bUsage) return aUsage - bUsage;

        return (staticRank.get(a) ?? Number.MAX_SAFE_INTEGER) - (staticRank.get(b) ?? Number.MAX_SAFE_INTEGER);
    });
}

export function buildJwcModelOptions(
    authenticated: string[],
    error?: string,
    defaultModelRole?: string,
    usageOrder: string[] = [],
    modelCatalog: Map<string, string[]> = new Map(),
): JwcModelOptions {
    const providerIds = authenticated.length > 0 ? authenticated : ['anthropic'];
    const rawProviders = providerIds.map(id => ({
        id,
        models: providerCatalogModels(id, modelCatalog),
        efforts: JWC_PROVIDER_EFFORT_DEFAULTS[id] ?? [],
    }));
    const filteredUsageOrder = filterJwcModelUsageOrder(usageOrder, rawProviders);
    const providers = rawProviders.map(provider => ({
        ...provider,
        models: sortModelsForProvider(provider.id, provider.models, defaultModelRole, filteredUsageOrder),
    }));
    const parsedDefault = parseJwcModelRole(defaultModelRole);
    const configuredProvider = providers.find(entry => entry.id === parsedDefault?.provider);
    const configuredModel = configuredProvider?.models.includes(parsedDefault?.model ?? '') ? parsedDefault?.model : undefined;
    const defaultProvider = configuredProvider && configuredModel
        ? configuredProvider.id
        : providerIds.includes('anthropic') ? 'anthropic' : providerIds[0] ?? 'anthropic';
    const defaultModel = configuredProvider && configuredModel
        ? configuredModel
        : JWC_PROVIDER_MODEL_DEFAULTS[defaultProvider]?.[0] ?? '';
    return {
        providers,
        defaultProvider,
        defaultModel,
        ...(filteredUsageOrder.length > 0 ? { usageOrder: filteredUsageOrder } : {}),
        ...(authenticated.length === 0 ? { degraded: true, error: error ?? 'No authenticated JWC providers found; using Anthropic defaults.' } : {}),
    };
}

export async function discoverJwcAuthenticatedProviders(): Promise<string[]> {
    const sdk: { discoverAuthStorage(dir: string): Promise<{ list(): Promise<string[]> }> } =
        await (Function('return import("jawcode/sdk")')() as Promise<typeof sdk>);
    const auth = await sdk.discoverAuthStorage(
        resolveJwcAgentDir(),
    );
    const providers = await auth.list();
    return Array.isArray(providers)
        ? providers.filter((provider): provider is string => typeof provider === 'string' && provider.length > 0)
        : [];
}

export async function resolveJwcModelOptions(): Promise<JwcModelOptions> {
    try {
        const [authenticated, defaultModelRole] = await Promise.all([
            discoverJwcAuthenticatedProviders(),
            readJwcDefaultModelRole(),
        ]);
        const usageOrder = readJwcModelUsageOrder();
        const modelCatalog = readJwcModelCache();
        return buildJwcModelOptions(authenticated, undefined, defaultModelRole, usageOrder, modelCatalog);
    } catch (err) {
        return buildJwcModelOptions([], err instanceof Error ? err.message : String(err));
    }
}
