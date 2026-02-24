// ── Shared constants (frontend) ──

const FALLBACK_CLI_REGISTRY = {
    claude: {
        label: 'Claude',
        efforts: ['low', 'medium', 'high'],
        models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6[1m]', 'claude-haiku-4-5-20251001'],
    },
    codex: {
        label: 'Codex',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        models: ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    },
    gemini: {
        label: 'Gemini',
        efforts: [],
        models: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    },
    opencode: {
        label: 'OpenCode',
        efforts: ['minimal', 'low', 'high', 'max'],
        models: [
            'anthropic/claude-opus-4-6-thinking',
            'anthropic/claude-sonnet-4-6-thinking',
            'anthropic/claude-sonnet-4-6',
            'openai/gpt-5.3-codex-xhigh',
            'openai/gpt-5.3-codex-high',
            'opencode/big-pickle',
            'opencode/GLM-5 Free',
            'opencode/MiniMax M2.5 Free',
            'opencode/Kimi K2.5 Free',
            'opencode/GPT 5 Nano Free',
            'opencode/Grok Code Fast 1 Free',
        ],
    },
    copilot: {
        label: 'Copilot',
        efforts: ['low', 'medium', 'high'],
        models: [
            'claude-sonnet-4.6',
            'claude-opus-4.6',
            'claude-haiku-4.5',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex',
            'gpt-4.1',
            'gpt-5-mini',
            'gemini-3-pro-preview',
        ],
    },
};

function toModelMap(registry) {
    const out = {};
    for (const [key, value] of Object.entries(registry || {})) {
        out[key] = Array.isArray(value?.models) ? [...value.models] : [];
    }
    return out;
}

function normalizeRegistry(input) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (!value || typeof value !== 'object') continue;
        out[key] = {
            label: value.label || key,
            efforts: Array.isArray(value.efforts) ? [...value.efforts] : [],
            models: Array.isArray(value.models) ? [...value.models] : [],
        };
    }
    return out;
}

export let CLI_REGISTRY = normalizeRegistry(FALLBACK_CLI_REGISTRY);
export let CLI_KEYS = Object.keys(CLI_REGISTRY);
export let MODEL_MAP = toModelMap(CLI_REGISTRY);

function applyRegistry(registry) {
    const normalized = normalizeRegistry(registry);
    if (!Object.keys(normalized).length) return false;
    CLI_REGISTRY = normalized;
    CLI_KEYS = Object.keys(normalized);
    MODEL_MAP = toModelMap(normalized);
    return true;
}

export async function loadCliRegistry() {
    try {
        const response = await fetch('/api/cli-registry');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!applyRegistry(data)) throw new Error('invalid registry');
    } catch (e) {
        console.warn('[cli-registry] fallback:', e.message);
        applyRegistry(FALLBACK_CLI_REGISTRY);
    }
    return CLI_REGISTRY;
}

export function getCliKeys() {
    return CLI_KEYS;
}

export function getCliMeta(cli) {
    return CLI_REGISTRY[cli] || null;
}

export const ROLE_PRESETS = [
    { value: 'frontend', label: '🎨 프런트엔드', prompt: 'UI/UX 구현, CSS, 컴포넌트 개발', skill: 'dev-frontend' },
    { value: 'backend', label: '⚙️ 백엔드', prompt: 'API, DB, 서버 로직 구현', skill: 'dev-backend' },
    { value: 'data', label: '📊 데이터', prompt: '데이터 파이프라인, 분석, ML', skill: 'dev-data' },
    { value: 'docs', label: '📝 문서작성', prompt: '문서화, README, API docs', skill: 'documentation' },
    { value: 'custom', label: '✏️ 커스텀...', prompt: '', skill: null },
];
