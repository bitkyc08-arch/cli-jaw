// Cursor model/effort helpers.
// Cursor CLI does not expose --effort; effort is encoded in account model IDs.

export const CURSOR_EFFORT_CHOICES = [
    'none', 'none-fast', 'low', 'low-fast', 'medium', 'medium-fast',
    'high', 'high-fast', 'xhigh', 'xhigh-fast', 'max', 'max-fast',
] as const;

export const CURSOR_MODEL_IDS = [
    'auto',
    'gpt-5.3-codex-low',
    'gpt-5.3-codex-low-fast',
    'gpt-5.3-codex',
    'gpt-5.3-codex-fast',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-high-fast',
    'gpt-5.3-codex-xhigh',
    'gpt-5.3-codex-xhigh-fast',
    'gpt-5.2',
    'gpt-5.2-codex-low',
    'gpt-5.2-codex-low-fast',
    'gpt-5.2-codex',
    'gpt-5.2-codex-fast',
    'gpt-5.2-codex-high',
    'gpt-5.2-codex-high-fast',
    'gpt-5.2-codex-xhigh',
    'gpt-5.2-codex-xhigh-fast',
    'gpt-5.1-codex-max-low',
    'gpt-5.1-codex-max-low-fast',
    'gpt-5.1-codex-max-medium',
    'gpt-5.1-codex-max-medium-fast',
    'gpt-5.1-codex-max-high',
    'gpt-5.1-codex-max-high-fast',
    'gpt-5.1-codex-max-xhigh',
    'gpt-5.1-codex-max-xhigh-fast',
    'composer-2.5',
    'gpt-5.5-high',
    'gpt-5.5-high-fast',
    'claude-opus-4-7-thinking-high',
    'gpt-5.4-high',
    'gpt-5.4-high-fast',
    'claude-4.6-opus-high-thinking',
    'claude-4.6-opus-high-thinking-fast',
    'composer-2.5-fast',
    'gpt-5.5-none',
    'gpt-5.5-none-fast',
    'gpt-5.5-low',
    'gpt-5.5-low-fast',
    'gpt-5.5-medium',
    'gpt-5.5-medium-fast',
    'gpt-5.5-extra-high',
    'gpt-5.5-extra-high-fast',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'claude-4.6-sonnet-medium',
    'claude-4.6-sonnet-medium-thinking',
    'claude-sonnet-5',
    'claude-opus-4-7-low',
    'claude-opus-4-7-low-fast',
    'claude-opus-4-7-medium',
    'claude-opus-4-7-medium-fast',
    'claude-opus-4-7-high',
    'claude-opus-4-7-high-fast',
    'claude-opus-4-7-xhigh',
    'claude-opus-4-7-xhigh-fast',
    'claude-opus-4-7-max',
    'claude-opus-4-7-max-fast',
    'claude-opus-4-7-thinking-low',
    'claude-opus-4-7-thinking-low-fast',
    'claude-opus-4-7-thinking-medium',
    'claude-opus-4-7-thinking-medium-fast',
    'claude-opus-4-7-thinking-high-fast',
    'claude-opus-4-7-thinking-xhigh',
    'claude-opus-4-7-thinking-xhigh-fast',
    'claude-opus-4-7-thinking-max',
    'claude-opus-4-7-thinking-max-fast',
    'claude-opus-4-8-thinking-high',
    'claude-opus-4-8-low',
    'claude-opus-4-8-low-fast',
    'claude-opus-4-8-medium',
    'claude-opus-4-8-medium-fast',
    'claude-opus-4-8-high',
    'claude-opus-4-8-high-fast',
    'claude-opus-4-8-xhigh',
    'claude-opus-4-8-xhigh-fast',
    'claude-opus-4-8-max',
    'claude-opus-4-8-max-fast',
    'claude-opus-4-8-thinking-low',
    'claude-opus-4-8-thinking-low-fast',
    'claude-opus-4-8-thinking-medium',
    'claude-opus-4-8-thinking-medium-fast',
    'claude-opus-4-8-thinking-high-fast',
    'claude-opus-4-8-thinking-xhigh',
    'claude-opus-4-8-thinking-xhigh-fast',
    'claude-opus-4-8-thinking-max',
    'claude-opus-4-8-thinking-max-fast',
    'grok-4.5',
    'grok-4.5-fast',
    'gpt-5.4-low',
    'gpt-5.4-medium',
    'gpt-5.4-medium-fast',
    'gpt-5.4-xhigh',
    'gpt-5.4-xhigh-fast',
    'claude-4.6-opus-high',
    'claude-4.6-opus-max',
    'claude-4.6-opus-max-thinking',
    'claude-4.6-opus-max-thinking-fast',
    'claude-4.5-opus-high',
    'claude-4.5-opus-high-thinking',
    'gpt-5.2-low',
    'gpt-5.2-low-fast',
    'gpt-5.2-fast',
    'gpt-5.2-high',
    'gpt-5.2-high-fast',
    'gpt-5.2-xhigh',
    'gpt-5.2-xhigh-fast',
    'gemini-3.1-pro',
    'gpt-5.4-mini-none',
    'gpt-5.4-mini-low',
    'gpt-5.4-mini-medium',
    'gpt-5.4-mini-high',
    'gpt-5.4-mini-xhigh',
    'gpt-5.4-nano-none',
    'gpt-5.4-nano-low',
    'gpt-5.4-nano-medium',
    'gpt-5.4-nano-high',
    'gpt-5.4-nano-xhigh',
    'claude-4.5-sonnet',
    'claude-4.5-sonnet-thinking',
    'gpt-5.1-low',
    'gpt-5.1',
    'gpt-5.1-high',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.5-flash',
    'gpt-5.1-codex-mini-low',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-mini-high',
    'claude-4-sonnet',
    'claude-4-sonnet-thinking',
    'gpt-5-mini',
    'glm-5.2',
    'kimi-k2.7-code',
] as const;

export const CURSOR_REGISTRY_MODELS = [
    'auto',
    'composer-2.5',
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.1',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-fable-5-thinking',
    'claude-opus-4-8',
    'claude-opus-4-8-thinking',
    'claude-opus-4-7',
    'claude-opus-4-7-thinking',
    'claude-4.6-opus',
    'claude-4.6-sonnet',
    'claude-4.5-opus-high',
    'claude-4.5-sonnet',
    'claude-4-sonnet',
    'gemini-3.1-pro',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.5-flash',
    'grok-4.5',
    'gpt-5-mini',
    'glm-5.2',
    'kimi-k2.7-code',
] as const;

const CURSOR_EFFORT_SUFFIX: Record<string, string> = {
    none: 'none',
    'none-fast': 'none-fast',
    low: 'low',
    'low-fast': 'low-fast',
    medium: 'medium',
    'medium-fast': 'medium-fast',
    high: 'high',
    'high-fast': 'high-fast',
    xhigh: 'extra-high',
    'xhigh-fast': 'extra-high-fast',
    max: 'max',
    'max-fast': 'max-fast',
};

const CURSOR_EFFORTS = new Set<string>(CURSOR_EFFORT_CHOICES);
const CURSOR_MODEL_ID_SET = new Set<string>(CURSOR_MODEL_IDS);
const CURSOR_BASE_MODELS = new Set<string>(CURSOR_REGISTRY_MODELS);

function normalizeCursorValue(value: string | null | undefined): string {
    return String(value || '').trim();
}

function cursorEffortSuffix(base: string, effort: string): string | undefined {
    if ((effort === 'xhigh' || effort === 'xhigh-fast') && base !== 'gpt-5.5') {
        return effort;
    }
    return CURSOR_EFFORT_SUFFIX[effort];
}

export function isCursorFullModelId(model: string): boolean {
    const value = normalizeCursorValue(model);
    if (!value || value === 'default') return false;
    if (CURSOR_BASE_MODELS.has(value)) return false;
    return /-(none|low|medium|high|max|extra-high|xhigh)(-fast)?$/i.test(value)
        || /^composer-\d+(?:\.\d+)?-fast$/i.test(value);
}

export function resolveCursorModelVariant(model: string, effort: string): string {
    const base = normalizeCursorValue(model);
    const selectedEffort = normalizeCursorValue(effort);
    if (!base || base === 'default') return base || 'default';
    if (base === 'auto') return 'auto';
    if (isCursorFullModelId(base)) return base;

    if (base.startsWith('composer-')) {
        return selectedEffort === 'fast' || selectedEffort === 'medium-fast'
            ? `${base}-fast`
            : base;
    }

    if (!selectedEffort || !CURSOR_EFFORTS.has(selectedEffort)) return base;
    const candidates: string[] = [];
    const suffix = cursorEffortSuffix(base, selectedEffort);
    if (suffix) candidates.push(`${base}-${suffix}`);
    if (selectedEffort === 'medium') candidates.push(base);
    if (selectedEffort === 'medium-fast') candidates.push(`${base}-fast`, base);
    if (selectedEffort === 'fast') candidates.push(`${base}-fast`);
    if (selectedEffort.endsWith('-fast')) {
        const baseEffort = selectedEffort.replace(/-fast$/, '');
        const baseSuffix = cursorEffortSuffix(base, baseEffort);
        if (baseSuffix) candidates.push(`${base}-${baseSuffix}`);
    }
    return candidates.find((candidate) => CURSOR_MODEL_ID_SET.has(candidate)) || base;
}
