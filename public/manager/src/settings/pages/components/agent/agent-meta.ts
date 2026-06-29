export type CliMeta = {
    label: string;
    models: ReadonlyArray<string>;
    efforts: ReadonlyArray<string>;
    defaultProvider?: string;
    providers?: ReadonlyArray<string>;
    modelsByProvider?: Record<string, ReadonlyArray<string>>;
    effortsByProvider?: Record<string, ReadonlyArray<string>>;
    effortNote?: string;
    modelNote?: string;
};

export type PerCliEntry = {
    provider?: string;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    contextWindowSize?: number;
    contextWindowCompactLimit?: number;
    [key: string]: unknown;
};

export type ActiveOverride = {
    provider?: string;
    model?: string;
    effort?: string;
};

const CODEX_MODELS: ReadonlyArray<string> = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];

export const PRIMARY_CLIS: ReadonlyArray<string> = ['pi', 'claude', 'claude-e', 'jwc', 'agy', 'codex', 'cursor', 'kiro-code', 'gemini'];

export const CLI_META: Record<string, CliMeta> = {
    agy: {
        label: 'Antigravity',
        models: ['gemini-3.5-flash'],
        efforts: [],
        modelNote: 'AGY model override is version-dependent. Current observed AGY 1.0.12 supports --model; cli-jaw probes the installed binary and emits this field only when supported. Leave empty to use native AGY selection.',
        effortNote: 'AGY has no separate effort flag.',
    },
    pi: {
        label: 'Pi',
        defaultProvider: 'progrok',
        providers: ['progrok'],
        models: ['grok-composer-2.5-fast', 'grok-4.3'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortNote: 'Pi runs through --mode rpc. grok-composer-2.5-fast is the verified default; bare grok-composer-2.5 currently has no team access.',
    },
    'ai-e': {
        label: 'AI-E',
        defaultProvider: 'claude',
        providers: ['claude', 'codex', 'gemini', 'grok', 'copilot', 'kiro'],
        models: ['opus', 'sonnet', 'haiku', ...CODEX_MODELS, 'gemini-3-flash-preview', 'grok-build', 'grok-composer-2.5-fast', 'gpt-5-mini'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        modelsByProvider: {
            claude: ['claude-fable-5', 'claude-opus-4-8', 'opus', 'sonnet', 'haiku'],
            codex: CODEX_MODELS,
            gemini: ['gemini-3-flash-preview'],
            grok: ['grok-build', 'grok-composer-2.5-fast'],
            copilot: ['gpt-5-mini'],
            kiro: ['auto', 'claude-sonnet-4.6', 'deepseek-3.2', 'minimax-m2.5', 'glm-5', 'qwen3-coder-next'],
        },
        effortsByProvider: {
            claude: ['low', 'medium', 'high', 'xhigh', 'max'],
            codex: ['low', 'medium', 'high', 'xhigh'],
            gemini: [],
            grok: [],
            copilot: ['low', 'medium', 'high'],
            kiro: ['low', 'medium', 'high', 'xhigh'],
        },
    },
    claude: {
        label: 'Claude',
        // Aliases + pinned full IDs (hyphen form — Anthropic API rejects
        // dot form). Aliases (opus/sonnet/...) follow Claude Code's
        // firstPartyNameToCanonical resolution; pinned IDs reach the API
        // verbatim for stable prompt-cache prefixes. The `[1m]` suffix is
        // parsed by Claude Code (stripped before send, enables 1M context
        // on Fable 5 + Opus 4.8/4.7/4.6 + Sonnet 4.6). Mirrors getDefaultClaudeChoices()
        // in src/cli/claude-models.ts. Verified via Grok web research
        // 2026-05-01 (devlog/_plan/260501_claude_model_passthrough/).
        models: [
            'opus',
            'sonnet',
            'sonnet[1m]',
            'haiku',
            'claude-fable-5',
            'claude-fable-5[1m]',
            'claude-opus-4-8',
            'claude-opus-4-8[1m]',
            'claude-opus-4-7',
            'claude-opus-4-7[1m]',
            'claude-opus-4-6',
            'claude-opus-4-6[1m]',
            'claude-sonnet-4-6',
            'claude-sonnet-4-6[1m]',
            'claude-haiku-4-5',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-e': {
        label: 'Claude E',
        models: [
            'opus', 'sonnet', 'haiku',
            'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    jwc: {
        label: 'JWC',
        defaultProvider: 'anthropic',
        providers: ['anthropic'],
        models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
        efforts: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
        modelsByProvider: {
            anthropic: [
                'claude-fable-5',
                'claude-opus-4-8',
                'claude-opus-4-7',
                'claude-opus-4-6',
                'claude-sonnet-4-6',
                'claude-haiku-4-5',
            ],
        },
        effortsByProvider: {
            anthropic: ['off', 'min', 'low', 'medium', 'high', 'xhigh'],
        },
    },
    codex: {
        label: 'Codex',
        models: CODEX_MODELS,
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    'codex-app': {
        label: 'Codex App',
        models: CODEX_MODELS,
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    cursor: {
        label: 'Cursor',
        models: [
            'auto', 'composer-2.5', 'composer-2',
            'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
            'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex',
            'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.1',
            'claude-fable-5', 'claude-fable-5-thinking',
            'claude-opus-4-8', 'claude-opus-4-8-thinking',
            'claude-opus-4-7', 'claude-opus-4-7-thinking',
            'claude-4.6-opus', 'claude-4.6-sonnet',
            'claude-4.5-opus-high', 'claude-4.5-sonnet', 'claude-4-sonnet',
            'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash',
            'grok-4.3', 'grok-build-0.1', 'gpt-5-mini', 'kimi-k2.5',
        ],
        efforts: ['none', 'none-fast', 'low', 'low-fast', 'medium', 'medium-fast', 'high', 'high-fast', 'xhigh', 'xhigh-fast', 'max', 'max-fast'],
        effortNote: 'Cursor effort resolves to model IDs; no separate --effort flag',
    },
    'kiro-code': {
        label: 'Kiro',
        models: [
            'auto',
            'claude-fable-5',
            'claude-opus-4.8',
            'claude-opus-4.7',
            'claude-opus-4.6',
            'claude-sonnet-4.6',
            'claude-opus-4.5',
            'claude-sonnet-4.5',
            'claude-sonnet-4',
            'claude-haiku-4.5',
            'deepseek-3.2',
            'minimax-m2.5',
            'minimax-m2.1',
            'glm-5',
            'qwen3-coder-next',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortNote: 'Kiro CLI forwards --effort; cli-jaw maps xhigh to Kiro max on the wire',
    },
    gemini: {
        label: 'Gemini',
        models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview'],
        efforts: [],
    },
    grok: {
        label: 'Grok',
        models: ['grok-build', 'grok-composer-2.5-fast'],
        efforts: [],
        effortNote: 'unsupported by grok-build/composer; do not pass --effort',
    },
    opencode: {
        label: 'OpenCode',
        models: ['opencode-go/kimi-k2.6', 'opencode-go/glm-5.1'],
        efforts: ['minimal', 'low', 'high', 'max'],
    },
    copilot: {
        label: 'Copilot',
        models: ['gpt-5.5', 'claude-fable-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-sonnet-4.6', 'gpt-5.4'],
        efforts: ['low', 'medium', 'high'],
    },
};

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringArrayRecord(value: unknown): Record<string, string[]> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, string[]> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) out[key] = stringArray(raw);
    return out;
}

export function normalizeCliMetaRegistry(raw: unknown): Record<string, CliMeta> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, CliMeta> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const modelsByProvider = stringArrayRecord(record['modelsByProvider']);
        const effortsByProvider = stringArrayRecord(record['effortsByProvider']);
        out[key] = {
            label: typeof record['label'] === 'string' ? record['label'] : key,
            models: stringArray(record['models']),
            efforts: stringArray(record['efforts']),
            ...(typeof record['defaultProvider'] === 'string' ? { defaultProvider: record['defaultProvider'] } : {}),
            ...(record['providers'] ? { providers: stringArray(record['providers']) } : {}),
            ...(modelsByProvider ? { modelsByProvider } : {}),
            ...(effortsByProvider ? { effortsByProvider } : {}),
            ...(typeof record['effortNote'] === 'string' ? { effortNote: record['effortNote'] } : {}),
            ...(typeof record['modelNote'] === 'string' ? { modelNote: record['modelNote'] } : {}),
        };
    }
    return out;
}

export function metaFor(cli: string, registry?: Record<string, CliMeta> | null): CliMeta {
    return registry?.[cli] || CLI_META[cli] || { label: cli, models: [], efforts: [] };
}

export function orderRuntimeCliOptions(cliOptions: ReadonlyArray<string>): string[] {
    const primary = PRIMARY_CLIS.filter((value) => cliOptions.includes(value));
    const secondary = cliOptions.filter((value) => !PRIMARY_CLIS.includes(value));
    return [...primary, ...secondary];
}

export function runtimeModelFor(
    cli: string,
    perCli: Record<string, PerCliEntry> = {},
    activeOverrides: Record<string, ActiveOverride> = {},
): string {
    return activeOverrides[cli]?.model || perCli[cli]?.model || '';
}

export function runtimeEffortFor(
    cli: string,
    perCli: Record<string, PerCliEntry> = {},
    activeOverrides: Record<string, ActiveOverride> = {},
): string {
    return activeOverrides[cli]?.effort || perCli[cli]?.effort || '';
}

export function optionList(values: ReadonlyArray<string>, current = ''): Array<{ value: string; label: string }> {
    const unique = new Set<string>();
    if (current) unique.add(current);
    for (const value of values) unique.add(value);
    return Array.from(unique).map((value) => ({ value, label: value }));
}
