import type { Page } from 'playwright-core';
import { WebAiError } from './errors.js';

type BoxLike = { x: number; y: number; width: number; height: number };
type BrowserNodeLike = {
    innerText?: string;
    textContent?: string | null;
    getBoundingClientRect(): BoxLike;
    getAttribute?(name: string): string | null;
};

declare const document: { querySelectorAll(selector: string): Iterable<BrowserNodeLike> };

export type ChatGptModelChoice = 'instant' | 'thinking' | 'pro';
export type ChatGptEffortChoice = 'light' | 'standard' | 'extended' | 'heavy';
/** parity2 030 slice 3.1 (C-01): GPT-5.6 family picker vocabulary. */
export type ChatGptFamilyChoice = 'gpt-5.6-sol' | 'gpt-5.5' | 'o3';

export const CHATGPT_FAMILY_OPTIONS: Readonly<Record<ChatGptFamilyChoice, { label: string }>> = Object.freeze({
    'gpt-5.6-sol': { label: 'GPT-5.6 Sol' },
    'gpt-5.5': { label: 'GPT-5.5' },
    o3: { label: 'o3' },
});

const FAMILY_ALIASES: Readonly<Record<string, ChatGptFamilyChoice>> = Object.freeze({
    'gpt-5.6-sol': 'gpt-5.6-sol',
    'gpt-5.6': 'gpt-5.6-sol',
    sol: 'gpt-5.6-sol',
    'gpt-5.5': 'gpt-5.5',
    o3: 'o3',
});

export function normalizeChatGptFamilyChoice(family: string | undefined): ChatGptFamilyChoice | null {
    const key = String(family || '').trim().toLowerCase();
    return key ? FAMILY_ALIASES[key] || null : null;
}

/** parity2 030 (C-01): Power-shell selectors — the 5.6 Chat picker renders a
 * Power menu item whose slider drives tier/effort; menu rows may not exist. */
export const CHATGPT_POWER_PICKER_ROOT_SELECTOR =
    '[role="menu"][data-state="open"]:has([role="menuitem"][aria-label="Power"])';
export const CHATGPT_POWER_SLIDER_VIEW_SELECTOR = [
    '[data-testid="composer-model-picker-slider-simple-view"]',
    '[data-testid="composer-model-picker-slider-advanced-view"]',
].join(', ');

export interface ChatGptModelSelectionEvidence {
    requestedModel: string | null;
    resolvedLabel: string | null;
    normalizedModel: ChatGptModelChoice | null;
    strategy: 'select';
    status: 'verified' | 'unverified';
    verified: boolean;
    source: 'chatgpt-model-picker';
    capturedAt: string;
}

export interface ChatGptModelSelectionResult {
    requested: ChatGptModelChoice | null;
    selected: ChatGptModelChoice | null;
    alreadySelected: boolean;
    effort?: ChatGptEffortChoice | null;
    requestedEffort?: ChatGptEffortChoice | null;
    usedFallbacks: string[];
    warnings: string[];
    modelSelection?: ChatGptModelSelectionEvidence;
}

/** 104.5: structured, persistable evidence of what model was requested vs resolved/verified. */
export function createModelSelectionEvidence(input: {
    requestedModel?: string | null;
    resolvedLabel?: string | null;
    normalizedModel?: ChatGptModelChoice | null;
    verified: boolean;
}): ChatGptModelSelectionEvidence {
    return {
        requestedModel: input.requestedModel ?? null,
        resolvedLabel: input.resolvedLabel ?? null,
        normalizedModel: input.normalizedModel ?? null,
        strategy: 'select',
        status: input.verified ? 'verified' : 'unverified',
        verified: input.verified,
        source: 'chatgpt-model-picker',
        capturedAt: new Date().toISOString(),
    };
}

export const CHATGPT_MODEL_SELECTOR_BUTTONS = [
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label="Model selector"]',
    'button[aria-label*="model selector" i]',
] as const;

const CHATGPT_COMPOSER_MODEL_PILL_SELECTORS = [
    'button.__composer-pill[aria-haspopup="menu"]',
    '[role="button"].__composer-pill[aria-haspopup="menu"]',
    'button.__composer-pill',
    '[role="button"].__composer-pill',
] as const;

const CHATGPT_MODEL_MENU_ITEM_SELECTOR = '[data-testid^="model-switcher-gpt-"]';
const CHATGPT_MODEL_TEXT_BUTTON_PATTERN = /^(ChatGPT|GPT[-\s]?\d|((Light|Standard|Extended|Heavy)\s+)?(Instant|Fast|Thinking|Pro|Heavy)\b|Medium\b|High\b|Extra High\b|Pro Standard\b|Pro Extended\b|즉시|중간|높음|매우 높음|Pro 확장|프로 확장|即时|思考|中等|极高|高|Pro 扩展)/i;
const CHATGPT_OBSERVED_PRO_PILL_LABELS = ['Standard Pro', 'Extended Pro'] as const;
const CHATGPT_EFFORT_TRIGGER_SELECTORS = [
    '[data-testid*="thinking-effort"]',
    '[data-testid*="reasoning-effort"]',
    '[data-testid*="effort"]',
    '[aria-label*="Effort" i]',
    '[aria-label*="Reasoning" i]',
    '[role="menuitem"][aria-label*="Effort" i]',
    '[role="menuitem"][aria-label*="Reasoning" i]',
] as const;

export const CHATGPT_MODEL_OPTIONS: Record<ChatGptModelChoice, { testIds: string[]; labels: string[] }> = {
    // parity2 030 slice 3.2 (C-20): zh projections added per label set — each list is
    // its old literal PLUS only the locale variants of those same terms (agbrowse G25).
    instant: { testIds: ['model-switcher-gpt-5-5', 'model-switcher-gpt-5-3'], labels: ['Instant', '즉시', '即时'] },
    thinking: { testIds: ['model-switcher-gpt-5-5-thinking', 'model-switcher-gpt-5-5-thinking-thinking-effort'], labels: ['Thinking', 'Medium', 'High', 'Extra High', '중간', '높음', '매우 높음', '思考', '中等', '高', '极高'] },
    pro: { testIds: ['model-switcher-gpt-5-5-pro', 'model-switcher-gpt-5-5-pro-thinking-effort'], labels: ['Pro', 'Heavy', 'Pro Standard', 'Pro Extended', 'Pro 확장', '프로 확장', 'Pro 扩展'] },
};

export const CHATGPT_MODEL_EFFORT_OPTIONS: Record<'thinking' | 'pro', { triggerTestIds: string[]; efforts: Partial<Record<ChatGptEffortChoice, string>> }> = {
    thinking: {
        triggerTestIds: ['model-switcher-gpt-5-5-thinking-thinking-effort'],
        efforts: {
            light: 'Light',
            standard: 'Standard',
            extended: 'Extended',
            heavy: 'Heavy',
        },
    },
    pro: {
        triggerTestIds: ['model-switcher-gpt-5-5-pro-thinking-effort'],
        efforts: {
            standard: 'Standard',
            extended: 'Extended',
        },
    },
};

const CHATGPT_SIMPLIFIED_INTELLIGENCE_OPTIONS: Readonly<Record<ChatGptModelChoice, {
    defaultLabels: readonly string[];
    efforts: Readonly<Partial<Record<ChatGptEffortChoice, readonly string[]>>>;
}>> = {
    instant: {
        defaultLabels: ['Instant', '즉시', '即时'],
        efforts: {
            light: ['Instant', '즉시', '即时'],
        },
    },
    thinking: {
        defaultLabels: ['Medium', '중간', '中等'],
        efforts: {
            light: ['Instant', '즉시', '即时'],
            standard: ['Medium', '중간', '中等'],
            extended: ['High', '높음', '高'],
            heavy: ['Extra High', '매우 높음', '极高'],
        },
    },
    pro: {
        defaultLabels: ['Pro Extended', 'Pro 확장', '프로 확장', 'Pro 扩展'],
        efforts: {
            standard: ['Pro Extended', 'Pro 확장', '프로 확장', 'Pro 扩展'],
            extended: ['Pro Extended', 'Pro 확장', '프로 확장', 'Pro 扩展'],
        },
    },
};

const MODEL_ALIASES: Record<string, ChatGptModelChoice> = {
    instant: 'instant',
    fast: 'instant',
    'gpt-5-3': 'instant',
    'gpt-5.3': 'instant',
    thinking: 'thinking',
    think: 'thinking',
    'gpt-5-5-thinking': 'thinking',
    'gpt-5.5-thinking': 'thinking',
    'gpt-5-6-thinking': 'thinking',
    'gpt-5.6-thinking': 'thinking',
    pro: 'pro',
    'gpt-5-5-pro': 'pro',
    'gpt-5.5-pro': 'pro',
    'gpt-5-6-pro': 'pro',
    'gpt-5.6-pro': 'pro',
};

const EFFORT_ALIASES: Record<string, ChatGptEffortChoice> = {
    light: 'light',
    low: 'light',
    standard: 'standard',
    normal: 'standard',
    regular: 'standard',
    default: 'standard',
    extended: 'extended',
    high: 'extended',
    heavy: 'heavy',
};

export function normalizeChatGptModelChoice(model: string | undefined): ChatGptModelChoice | null {
    const key = String(model || '').trim().toLowerCase();
    if (!key) return null;
    return MODEL_ALIASES[key] || null;
}

export function normalizeChatGptEffortChoice(effort: string | undefined): ChatGptEffortChoice | null {
    const key = String(effort || '').trim().toLowerCase();
    if (!key) return null;
    return EFFORT_ALIASES[key] || null;
}

export function isChatGptEffortSupported(model: string | undefined, effort: string | undefined): boolean {
    const requestedModel = normalizeChatGptModelChoice(model);
    const requestedEffort = normalizeChatGptEffortChoice(effort);
    if ((requestedModel !== 'thinking' && requestedModel !== 'pro') || !requestedEffort) return false;
    return Boolean(CHATGPT_MODEL_EFFORT_OPTIONS[requestedModel].efforts[requestedEffort]);
}

export async function selectChatGptModel(page: Page, model: string | undefined, options: { effort?: string; reasoningEffort?: string } = {}): Promise<ChatGptModelSelectionResult | null> {
    const requested = normalizeChatGptModelChoice(model);
    const requestedEffort = normalizeChatGptEffortChoice(options.effort || options.reasoningEffort);
    if (!requested) {
        if (model) throw new WebAiError({
            errorCode: 'provider.model-mismatch',
            stage: 'provider-select-mode',
            vendor: 'chatgpt',
            retryHint: 'model-fallback',
            message: `unsupported ChatGPT model selection: ${model}`,
            evidence: { model },
        });
        if (!requestedEffort) return null;
    }
    if ((options.effort || options.reasoningEffort) && !requestedEffort) {
        throw new WebAiError({
            errorCode: 'provider.model-mismatch',
            stage: 'provider-select-mode',
            vendor: 'chatgpt',
            retryHint: 'model-fallback',
            message: `unsupported ChatGPT reasoning effort: ${options.effort || options.reasoningEffort}`,
            evidence: { effort: options.effort || options.reasoningEffort },
        });
    }

    const usedFallbacks: string[] = [];
    const warnings: string[] = [];
    try {
        await openModelMenu(page, usedFallbacks);
    } catch (err) {
        if (!isSelectionUnavailable(err)) throw err;
        return {
            requested: requested || null,
            selected: null,
            alreadySelected: true,
            effort: null,
            requestedEffort: requestedEffort || null,
            usedFallbacks: [...usedFallbacks, 'model-selector-unavailable-current-model'],
            warnings: [buildModelSelectionWarning(requested, requestedEffort, err)],
        };
    }
    let currentModel = await readCheckedModel(page, requested || null);
    const targetModel = requested || currentModel;
    let modelChanged = false;
    if (!targetModel) {
        await closeModelMenu(page);
        throw new WebAiError({
            errorCode: 'provider.model-mismatch',
            stage: 'provider-select-mode',
            vendor: 'chatgpt',
            retryHint: 'model-fallback',
            message: 'ChatGPT model must be selected before setting reasoning effort',
            evidence: { effort: requestedEffort },
        });
    }
    if (requested && currentModel !== requested) {
        // parity2 030 slice 3.1 (C-01): bounded retry (menu re-render race) with a
        // Power-slider fallback — on the 5.6 Power shell the menu rows may not
        // exist at all and the slider IS the selection control.
        let attempt = 0;
        const MODEL_SELECT_MAX_ATTEMPTS = 3;
        while (currentModel !== requested && attempt < MODEL_SELECT_MAX_ATTEMPTS) {
            attempt += 1;
            const option = await findModelOption(page, requested);
            if (!option) {
                if (!(await isChatGptPowerPickerOpen(page))) {
                    await openModelMenu(page, usedFallbacks).catch(() => undefined);
                }
                if (await isChatGptPowerPickerOpen(page)
                    && await selectChatGptPowerTierBySlider(page, requested, { effort: requestedEffort || null, usedFallbacks })) {
                    await page.waitForTimeout(400).catch(() => undefined);
                    currentModel = await readCheckedModel(page, requested);
                    modelChanged = true;
                    continue;
                }
                throw new WebAiError({
                    errorCode: 'provider.model-mismatch',
                    stage: 'provider-select-mode',
                    vendor: 'chatgpt',
                    retryHint: 'model-fallback',
                    message: `ChatGPT model option not found: ${requested}`,
                    evidence: { requested },
                });
            }
            await option.click({ timeout: 5_000 });
            await page.waitForTimeout(750).catch(() => undefined);
            await openModelMenu(page, usedFallbacks);
            currentModel = await readCheckedModel(page, requested);
            modelChanged = true;
        }
        if (currentModel !== requested && !warnings.includes('model-selection-unverified')) {
            warnings.push('model-selection-unverified');
        }
    }

    let selectedEffort: { selected: ChatGptEffortChoice; changed: boolean } | null = null;
    if (requestedEffort) {
        // parity2 030 (C-01): the Power shell's 5-stop slider IS the effort
        // control for thinking — try it before the legacy effort-portal path.
        let sliderApplied = false;
        if (targetModel === 'thinking') {
            await openModelMenu(page, usedFallbacks).catch(() => undefined);
            if (await isChatGptPowerPickerOpen(page)
                && await selectChatGptPowerTierBySlider(page, 'thinking', { effort: requestedEffort, usedFallbacks })) {
                const stop = await readChatGptPowerSliderState(page);
                if (effortChoiceFromPowerTierLabel(stop.label, stop.index) === requestedEffort) {
                    selectedEffort = { selected: requestedEffort, changed: true };
                    usedFallbacks.push('thinking-effort-power-slider-direct');
                    sliderApplied = true;
                }
            }
        }
        if (!sliderApplied) {
            try {
                selectedEffort = await selectChatGptEffort(page, targetModel, requestedEffort, usedFallbacks);
                await openModelMenu(page, usedFallbacks);
            } catch (err) {
                if (!isSelectionUnavailable(err)) throw err;
                usedFallbacks.push('reasoning-effort-unavailable-current-effort');
                warnings.push(`reasoning effort ${requestedEffort} was not enforced: ${errorMessage(err)}`);
                await closeModelMenu(page);
            }
        }
    }
    // Effort observation MUST be captured while the Power shell is still open:
    // the tier string lives inside the shell that closeModelMenu() unmounts.
    let observedEffort: ChatGptEffortChoice | null = null;
    if (requestedEffort && targetModel === 'thinking' && await isChatGptPowerPickerOpen(page)) {
        const stop = await readChatGptPowerSliderState(page);
        observedEffort = effortChoiceFromPowerTierLabel(stop.label, stop.index);
    }
    const after = await readCheckedModel(page, targetModel);
    await closeModelMenu(page);
    if (after !== targetModel) {
        usedFallbacks.push('model-verification-unavailable-current-model');
        warnings.push(`model ${targetModel} was not verified; current detected model is ${after || 'unknown'}`);
    }
    // parity2 030 (C-01): effort is its own verification axis — a wrong tier must
    // not report as verified just because the model axis matched.
    const effortVerified = !requestedEffort
        || targetModel !== 'thinking'
        || selectedEffort?.selected === requestedEffort
        || observedEffort === requestedEffort;
    if (requestedEffort && !effortVerified) {
        usedFallbacks.push('effort-verification-unavailable-current-effort');
        warnings.push('effort-selection-unverified');
        warnings.push(`effort ${requestedEffort} was not applied; observed ${observedEffort || 'unknown'}`);
    }
    const effortReportable = effortVerified ? selectedEffort : null;
    return {
        requested: requested || targetModel,
        selected: after,
        alreadySelected: !modelChanged && !effortReportable?.changed && effortVerified,
        effort: effortReportable?.selected || null,
        requestedEffort: requestedEffort || null,
        usedFallbacks,
        warnings,
        modelSelection: createModelSelectionEvidence({
            requestedModel: model ?? null,
            resolvedLabel: after,
            normalizedModel: targetModel,
            verified: after === targetModel && effortVerified,
        }),
    };
}

function isSelectionUnavailable(err: unknown): boolean {
    const message = errorMessage(err);
    if (err instanceof WebAiError && err.errorCode === 'provider.model-mismatch' && err.stage === 'provider-select-mode') {
        return /ChatGPT model selector not found/i.test(message);
    }
    return /ChatGPT model selector not found/i.test(message);
}

function buildModelSelectionWarning(
    requested: ChatGptModelChoice | null,
    requestedEffort: ChatGptEffortChoice | null,
    err: unknown,
): string {
    const modelText = requested
        ? `requested ${requested} was not enforced`
        : 'model selector unavailable';
    const effortText = requestedEffort
        ? `; requested effort ${requestedEffort} was not enforced`
        : '';
    return `${modelText}${effortText}, continuing with current ChatGPT model: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
    return (err as { message?: string })?.message || String(err);
}

async function closeModelMenu(page: Page): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        if (!(await isModelMenuOpen(page))) return;
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
    }
}

async function openModelMenu(page: Page, usedFallbacks: string[]): Promise<void> {
    if (await isModelMenuOpen(page)) return;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        for (const selector of CHATGPT_MODEL_SELECTOR_BUTTONS) {
            const loc = page.locator(selector).first();
            if (!(await loc.isVisible().catch(() => false))) continue;
            await loc.click({ timeout: 5_000 });
            await page.waitForTimeout(400).catch(() => undefined);
            if (await isModelMenuOpen(page)) return;
        }
        const composerPill = await findComposerModelPill(page);
        if (composerPill) {
            usedFallbacks.push('composer-model-pill');
            await composerPill.click({ timeout: 5_000 });
            await page.waitForTimeout(400).catch(() => undefined);
            if (await isModelMenuOpen(page)) return;
        }
        await page.waitForTimeout(250).catch(() => undefined);
    }
    usedFallbacks.push('model-menu-text-button');
    const textButton = await findModelTextButton(page);
    if (textButton && await textButton.isVisible().catch(() => false)) {
        await textButton.click({ timeout: 5_000 });
        await page.waitForTimeout(400).catch(() => undefined);
        if (await isModelMenuOpen(page)) return;
    }
    throw new WebAiError({
        errorCode: 'provider.model-mismatch',
        stage: 'provider-select-mode',
        vendor: 'chatgpt',
        retryHint: 'model-fallback',
        message: `ChatGPT model selector not found. Tried: ${[...CHATGPT_MODEL_SELECTOR_BUTTONS, ...CHATGPT_COMPOSER_MODEL_PILL_SELECTORS].join(', ')}`,
        selectorsTried: [...CHATGPT_MODEL_SELECTOR_BUTTONS, ...CHATGPT_COMPOSER_MODEL_PILL_SELECTORS],
    });
}

async function findComposerModelPill(page: Page): Promise<ReturnType<Page['locator']> | null> {
    let standaloneEffort: ReturnType<Page['locator']> | null = null;
    for (const selector of CHATGPT_COMPOSER_MODEL_PILL_SELECTORS) {
        const candidates = await page.locator(selector).count().catch(() => 0);
        for (let index = candidates - 1; index >= 0; index -= 1) {
            const loc = page.locator(selector).nth(index);
            if (!(await loc.isVisible().catch(() => false))) continue;
            const text = await loc.innerText({ timeout: 1_000 }).catch(() => '');
            const trimmed = text.trim();
            if (!isModelPillText(trimmed)) continue;
            if (isStandaloneEffortLabel(trimmed)) {
                if (!standaloneEffort) standaloneEffort = loc;
                continue;
            }
            return loc;
        }
    }
    return standaloneEffort || findModelTextButton(page);
}

async function findModelTextButton(page: Page): Promise<ReturnType<Page['locator']> | null> {
    let standaloneEffort: ReturnType<Page['locator']> | null = null;
    const candidates = await page.locator('button').count().catch(() => 0);
    for (let index = candidates - 1; index >= 0; index -= 1) {
        const loc = page.locator('button').nth(index);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
        if (!isModelPillText(text)) continue;
        if (isStandaloneEffortLabel(text)) {
            if (!standaloneEffort) standaloneEffort = loc;
            continue;
        }
        return loc;
    }
    return standaloneEffort;
}

async function findModelOption(page: Page, choice: ChatGptModelChoice): Promise<ReturnType<Page['locator']> | null> {
    const option = CHATGPT_MODEL_OPTIONS[choice];
    await openSimplifiedIntelligenceSubmenu(page).catch(() => undefined);
    for (const testId of option.testIds) {
        const loc = page.locator(`[role="menuitemradio"][data-testid="${testId}"], [data-testid="${testId}"]`).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        if (!(await isModelOptionCandidate(loc, choice))) continue;
        return loc;
    }
    for (const label of option.labels) {
        const candidates = page.locator('[role="menuitemradio"], [role="menuitem"]').filter({ hasText: modelLabelPattern(choice, label) });
        const count = await candidates.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const loc = candidates.nth(index);
            if (!(await loc.isVisible().catch(() => false))) continue;
            if (!(await isModelOptionCandidate(loc, choice))) continue;
            return loc;
        }
    }
    const simplified = await findOptionByExactLabels(page, simplifiedDefaultLabels(choice));
    if (simplified && await isSimplifiedIntelligenceMenuOpen(page, choice, null)) return simplified;
    if (simplified && await isModelOptionCandidate(simplified, choice)) return simplified;
    return null;
}

async function openSimplifiedIntelligenceSubmenu(page: Page): Promise<void> {
    if (await isSimplifiedIntelligenceMenuOpen(page, null, null)) return;
    const candidates = page.locator('[role="menuitem"], [role="button"], button').filter({ hasText: /^GPT[-\s]?5\.5$/i });
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
        const loc = candidates.nth(index);
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.hover({ timeout: 1_000 }).catch(() => undefined);
        await page.waitForTimeout(150).catch(() => undefined);
        if (await isSimplifiedIntelligenceMenuOpen(page, null, null)) return;
        await loc.focus({ timeout: 1_000 }).catch(() => undefined);
        await page.keyboard.press('ArrowRight').catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
        if (await isSimplifiedIntelligenceMenuOpen(page, null, null)) return;
        await loc.click({ timeout: 1_000 }).catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
        if (await isSimplifiedIntelligenceMenuOpen(page, null, null)) return;
    }
}

async function isModelOptionCandidate(loc: ReturnType<Page['locator']>, choice: ChatGptModelChoice): Promise<boolean> {
    const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
    if (!text) return false;
    if (isStandaloneEffortLabel(text) || (CHATGPT_OBSERVED_PRO_PILL_LABELS as readonly string[]).includes(text)) return false;
    if (choice === 'pro' && isLegacyProModelLabel(text)) return false;
    return modelChoiceFromText(text) === choice;
}

async function selectChatGptEffort(page: Page, model: ChatGptModelChoice, effort: ChatGptEffortChoice, usedFallbacks: string[]): Promise<{ selected: ChatGptEffortChoice; changed: boolean }> {
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    if (!config?.efforts?.[effort]) throw new Error(`ChatGPT reasoning effort ${effort} is not available for ${model}`);
    await openEffortMenu(page, model, effort, usedFallbacks);
    const before = await readCheckedEffort(page, model, effort);
    if (before === effort) return { selected: before, changed: false };
    const option = await findEffortOption(page, model, effort);
    if (!option) throw new Error(`ChatGPT reasoning effort option not found: ${model}/${effort}`);
    await option.click({ timeout: 5_000 });
    await page.waitForTimeout(500).catch(() => undefined);
    await openEffortMenu(page, model, effort, usedFallbacks);
    const after = await readCheckedEffort(page, model, effort);
    if (after !== effort) throw new Error(`ChatGPT reasoning effort verification failed: expected ${effort}, got ${after || 'none'}`);
    return { selected: after, changed: true };
}

async function findEffortOption(page: Page, model: ChatGptModelChoice, effort: ChatGptEffortChoice): Promise<ReturnType<Page['locator']> | null> {
    const label = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro']?.efforts?.[effort];
    if (!label) return null;
    const simplified = await findOptionByExactLabels(page, simplifiedEffortLabels(model, effort));
    if (simplified) return simplified;
    const candidates = page.locator('[role="menuitemradio"], [role="menuitem"]').filter({ hasText: effortLabelPattern(label) });
    const modelSpecific = candidates.filter({ hasText: modelLabelPattern(model, CHATGPT_MODEL_OPTIONS[model]?.labels?.[0] || '') }).last();
    if (await modelSpecific.isVisible().catch(() => false)) return modelSpecific;
    const option = candidates.last();
    return (await option.isVisible().catch(() => false)) ? option : null;
}

async function openEffortMenu(page: Page, model: ChatGptModelChoice, effort: ChatGptEffortChoice, usedFallbacks: string[]): Promise<void> {
    if (await isEffortMenuOpen(page, model, { effort })) return;
    if (!(await isModelMenuOpen(page))) await openModelMenu(page, usedFallbacks);
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    if (!config) throw new Error(`ChatGPT reasoning effort is not available for ${model}`);
    const row = await findModelOption(page, model);
    const rowBox = row ? await row.boundingBox().catch(() => null) : null;
    if (rowBox) {
        await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2).catch(() => undefined);
        await page.waitForTimeout(150).catch(() => undefined);
    } else if (row) {
        await row.hover({ timeout: 2_000 }).catch(() => undefined);
    }
    for (const testId of config.triggerTestIds) {
        const trigger = page.locator(`[data-testid="${testId}"]`).first();
        if (!(await trigger.count().then(count => count > 0).catch(() => false))) continue;
        if (await trigger.isVisible().catch(() => false)) {
            await trigger.click({ timeout: 2_000 }).catch(() => undefined);
            await page.waitForTimeout(300).catch(() => undefined);
            if (await isEffortMenuOpen(page, model, { effort })) return;
            await dismissEffortMenuAndReopenModel(page, usedFallbacks);
        }
    }
    for (const selector of CHATGPT_EFFORT_TRIGGER_SELECTORS) {
        const trigger = page.locator(selector).last();
        if (!(await trigger.isVisible().catch(() => false))) continue;
        await trigger.click({ timeout: 2_000 }).catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model, { effort, allowUnlabeled: false })) {
            usedFallbacks.push(`${model}-effort-generic-trigger`);
            return;
        }
        await dismissEffortMenuAndReopenModel(page, usedFallbacks);
    }
    const textTrigger = page.locator('button, [role="button"], [role="menuitem"]').filter({ hasText: /^(Effort|Reasoning effort)$/i }).last();
    if (await textTrigger.isVisible().catch(() => false)) {
        await textTrigger.click({ timeout: 2_000 }).catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model, { effort, allowUnlabeled: false })) {
            usedFallbacks.push(`${model}-effort-text-trigger`);
            return;
        }
        await dismissEffortMenuAndReopenModel(page, usedFallbacks);
    }
    if (row) {
        await row.focus({ timeout: 1_000 }).catch(() => undefined);
        await page.keyboard.press('ArrowRight').catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model, { effort })) {
            usedFallbacks.push(`${model}-effort-keyboard-open`);
            return;
        }
    }
    const fallbackBox = await findEffortTriggerBoxNearModelRow(page, model);
    if (fallbackBox) {
        await page.mouse.move(fallbackBox.x + fallbackBox.width / 2, fallbackBox.y + fallbackBox.height / 2).catch(() => undefined);
        await page.waitForTimeout(100).catch(() => undefined);
        await page.mouse.click(fallbackBox.x + fallbackBox.width / 2, fallbackBox.y + fallbackBox.height / 2).catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model, { effort })) {
            usedFallbacks.push(`${model}-effort-row-button`);
            return;
        }
    }
    usedFallbacks.push(`${model}-effort-trigger`);
    throw new Error(`ChatGPT reasoning effort selector not found for ${model}`);
}

async function dismissEffortMenuAndReopenModel(page: Page, usedFallbacks: string[]): Promise<void> {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(200).catch(() => undefined);
    await openModelMenu(page, usedFallbacks);
}

async function findEffortTriggerBoxNearModelRow(page: Page, model: ChatGptModelChoice): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const labels = CHATGPT_MODEL_OPTIONS[model]?.labels || [];
    return page.evaluate(({ expectedLabels, modelChoice, triggerSelectors }: { expectedLabels: string[]; modelChoice: ChatGptModelChoice; triggerSelectors: readonly string[] }) => {
        const rows = Array.from(document.querySelectorAll('[role="menuitemradio"][data-testid^="model-switcher-"], [role="menuitemradio"]'));
        const row = rows.find((candidate) => {
            const text = (candidate.innerText || candidate.textContent || '').trim();
            return matchesModelText(text, modelChoice, expectedLabels);
        });
        if (!row) return null;
        const rowRect = row.getBoundingClientRect();
        const selectorButtons = Array.from(document.querySelectorAll(triggerSelectors.join(',')));
        const textButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
            .filter((candidate: BrowserNodeLike) => /^(Effort|Reasoning effort)$/i.test((candidate.innerText || candidate.textContent || '').trim()));
        const effortButtons = [...selectorButtons, ...textButtons];
        const button = effortButtons.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const rowCenterY = rowRect.y + rowRect.height / 2;
            return rect.width > 0 && rect.height > 0 && rowCenterY >= rect.y && rowCenterY <= rect.y + rect.height;
        });
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        function matchesModelText(text: string, choice: ChatGptModelChoice, labelsForChoice: string[]): boolean {
            if (choice === 'instant') return /\b(Instant|Fast)\b/i.test(text);
            if (choice === 'thinking') return /\b(Thinking|Think)\b/i.test(text);
            if (choice === 'pro') return /\b(Pro|Heavy)\b/i.test(text);
            return labelsForChoice.some(label => new RegExp(`(^|\\s)${label}\\b`, 'i').test(text));
        }
    }, { expectedLabels: labels, modelChoice: model, triggerSelectors: CHATGPT_EFFORT_TRIGGER_SELECTORS }).catch(() => null);
}

async function readCheckedEffort(page: Page, model: ChatGptModelChoice, preferredEffort: ChatGptEffortChoice | null = null): Promise<ChatGptEffortChoice | null> {
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    const checkedRows = await page.locator('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"][data-state="checked"]')
        .all()
        .catch(() => []);
    for (const row of checkedRows) {
        const text = (await row.innerText({ timeout: 500 }).catch(() => '')).trim();
        const simplified = effortChoiceFromSimplifiedText(text, model, preferredEffort);
        if (simplified) return simplified;
    }
    for (const [effort, label] of Object.entries(config?.efforts || {}) as Array<[ChatGptEffortChoice, string]>) {
        const checked = await page.locator('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"][data-state="checked"]')
            .filter({ hasText: effortLabelPattern(label) })
            .last()
            .isVisible()
            .catch(() => false);
        if (checked) return effort;
    }
    const active = await readActiveEffortPill(page);
    for (const [effort, label] of Object.entries(config?.efforts || {}) as Array<[ChatGptEffortChoice, string]>) {
        if (effortLabelPattern(label).test(active)) return effort;
    }
    return null;
}

async function isEffortMenuOpen(page: Page, model: ChatGptModelChoice, options: { effort?: ChatGptEffortChoice; allowUnlabeled?: boolean } = {}): Promise<boolean> {
    const allowUnlabeled = options.allowUnlabeled !== false;
    const requestedEffort = options.effort || null;
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    if (!config) return false;
    if (await isSimplifiedIntelligenceMenuOpen(page, model, requestedEffort)) return true;
    const labels = Object.values(config.efforts).filter(Boolean) as string[];
    const requiredLabels = requiredEffortMenuLabels(model, requestedEffort);
    const unexpectedLabels = Object.entries(CHATGPT_MODEL_EFFORT_OPTIONS)
        .filter(([choice]) => choice !== model)
        .flatMap(([, option]) => Object.values(option.efforts))
        .filter((label): label is string => Boolean(label) && !labels.includes(label));
    return page.locator('[role="menu"]').evaluateAll((menus, { expectedLabels, requiredLabels, unexpectedLabels, modelChoice, allowUnlabeled }: { expectedLabels: string[]; requiredLabels: string[]; unexpectedLabels: string[]; modelChoice: ChatGptModelChoice; allowUnlabeled: boolean }) => {
        return menus.some(menu => {
            const text = (menu as BrowserNodeLike).innerText || menu.textContent || '';
            if (!menuTextMatchesModel(text, modelChoice, allowUnlabeled)) return false;
            const unexpectedMatches = unexpectedLabels.filter(label => new RegExp(`(^|\\s)${label}(\\s|$)`, 'i').test(text));
            if (unexpectedMatches.length > 0) return false;
            const requiredMatches = requiredLabels.filter(label => new RegExp(`(^|\\s)${label}(\\s|$)`, 'i').test(text));
            if (requiredMatches.length < requiredLabels.length) return false;
            const matches = expectedLabels.filter(label => new RegExp(`(^|\\s)${label}(\\s|$)`, 'i').test(text));
            const minimumMatches = requiredLabels.length || (expectedLabels.length <= 2 ? expectedLabels.length : Math.min(3, expectedLabels.length));
            return matches.length >= minimumMatches;
        });
        function menuTextMatchesModel(text: string, choice: ChatGptModelChoice, permitUnlabeled: boolean): boolean {
            const hasThinking = /\b(Thinking|Think)\b/i.test(text);
            const hasPro = /\bPro\b/i.test(text);
            if (!hasThinking && !hasPro) return permitUnlabeled;
            if (choice === 'thinking') return hasThinking && !hasPro;
            if (choice === 'pro') return hasPro && !hasThinking;
            return true;
        }
    }, { expectedLabels: labels, requiredLabels, unexpectedLabels, modelChoice: model, allowUnlabeled }).catch(() => false);
}

function requiredEffortMenuLabels(model: ChatGptModelChoice, effort: ChatGptEffortChoice | null): string[] {
    const efforts = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro']?.efforts || {};
    if (model === 'thinking') {
        const base = [efforts.standard, efforts.extended].filter(Boolean) as string[];
        if (effort === 'light' || effort === 'heavy') {
            return Array.from(new Set([...base, efforts[effort]].filter(Boolean) as string[]));
        }
        if (effort === 'standard' || effort === 'extended') return base;
    }
    if (model === 'pro') return Object.values(efforts).filter(Boolean) as string[];
    if (effort && efforts[effort]) return [efforts[effort] as string];
    return Object.values(efforts).filter(Boolean) as string[];
}

async function readCheckedModel(page: Page, expectedModel: ChatGptModelChoice | null = null): Promise<ChatGptModelChoice | null> {
    // parity2 030 (C-01): on the Power shell there are no checked radio rows —
    // the slider state is the selection evidence.
    if (await isChatGptPowerPickerOpen(page)) {
        const state = await readChatGptPowerSliderState(page);
        if (state.choice) return state.choice;
    }
    for (const [choice, option] of Object.entries(CHATGPT_MODEL_OPTIONS) as Array<[ChatGptModelChoice, typeof CHATGPT_MODEL_OPTIONS[ChatGptModelChoice]]>) {
        for (const testId of option.testIds) {
            const checked = await page.locator(`[role="menuitemradio"][data-testid="${testId}"][aria-checked="true"], [data-testid="${testId}"][aria-checked="true"]`).first().isVisible().catch(() => false);
            if (checked) return choice;
        }
    }
    const checkedRows = await page.locator('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"][data-state="checked"]').all().catch(() => []);
    for (const row of checkedRows) {
        const text = (await row.innerText({ timeout: 500 }).catch(() => '')).trim();
        if (isStandaloneEffortLabel(text)) continue;
        const choice = modelChoiceFromText(text);
        if (choice) return choice;
    }
    const active = await readActiveModelPill(page, { allowStandaloneHeavy: expectedModel === 'pro' });
    return modelChoiceFromText(active);
}

async function readActiveModelPill(page: Page, options: { allowStandaloneHeavy?: boolean } = {}): Promise<string> {
    const allowStandaloneHeavy = options.allowStandaloneHeavy === true;
    let standaloneHeavy = '';
    for (const selector of CHATGPT_COMPOSER_MODEL_PILL_SELECTORS) {
        const candidates = await page.locator(selector).count().catch(() => 0);
        for (let index = candidates - 1; index >= 0; index -= 1) {
            const loc = page.locator(selector).nth(index);
            if (!(await loc.isVisible().catch(() => false))) continue;
            const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
            if (!isModelPillText(text)) continue;
            if (isStandaloneEffortLabel(text)) {
                if (allowStandaloneHeavy && /^Heavy$/i.test(text) && !standaloneHeavy) standaloneHeavy = text;
                continue;
            }
            return text;
        }
    }
    const candidates = await page.locator('button').count().catch(() => 0);
    for (let index = candidates - 1; index >= 0; index -= 1) {
        const loc = page.locator('button').nth(index);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
        if (!isModelPillText(text)) continue;
        if (isStandaloneEffortLabel(text)) {
            if (allowStandaloneHeavy && /^Heavy$/i.test(text) && !standaloneHeavy) standaloneHeavy = text;
            continue;
        }
        return text;
    }
    return standaloneHeavy;
}

async function readActiveEffortPill(page: Page): Promise<string> {
    const labels = [...new Set(Object.values(CHATGPT_MODEL_EFFORT_OPTIONS).flatMap(option => Object.values(option.efforts)).filter(Boolean))] as string[];
    for (const selector of CHATGPT_COMPOSER_MODEL_PILL_SELECTORS) {
        const candidates = await page.locator(selector).count().catch(() => 0);
        for (let index = candidates - 1; index >= 0; index -= 1) {
            const loc = page.locator(selector).nth(index);
            if (!(await loc.isVisible().catch(() => false))) continue;
            const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
            if (labels.some(label => effortLabelPattern(label).test(text))) return text;
        }
    }
    const candidates = await page.locator('button').count().catch(() => 0);
    for (let index = candidates - 1; index >= 0; index -= 1) {
        const loc = page.locator('button').nth(index);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
        if (labels.some(label => effortLabelPattern(label).test(text))) return text;
    }
    return '';
}

async function isModelMenuOpen(page: Page): Promise<boolean> {
    // parity2 030 (C-01): the 5.6 Power shell counts as an open model menu.
    if (await isChatGptPowerPickerOpen(page)) return true;
    const legacyOpen = await page.locator(CHATGPT_MODEL_MENU_ITEM_SELECTOR)
        .filter({ hasText: CHATGPT_MODEL_TEXT_BUTTON_PATTERN })
        .evaluateAll((items: BrowserNodeLike[]) => items.some((item: BrowserNodeLike) => {
            const text = (item.innerText || item.textContent || '').trim();
            const testId = item.getAttribute?.('data-testid') || '';
            if (!text) return false;
            if (testId.includes('effort') && /^(Light|Standard|Extended|Heavy|Standard Pro|Extended Pro)$/i.test(text)) return false;
            return /^(ChatGPT|GPT[-\s]?\d|((Light|Standard|Extended|Heavy)\s+)?(Instant|Fast|Thinking|Pro|Heavy)\b|Medium\b|High\b|Extra High\b|Pro Standard\b|Pro Extended\b|즉시|중간|높음|매우 높음|Pro 확장|프로 확장)/i.test(text);
        }))
        .catch(() => false);
    if (legacyOpen || await isSimplifiedIntelligenceMenuOpen(page, null, null)) return true;
    return page.locator('[role="menuitem"], [role="button"], button')
        .filter({ hasText: /^GPT[-\s]?5\.5$/i })
        .first()
        .isVisible()
        .catch(() => false);
}

function modelLabelPattern(choice: ChatGptModelChoice, label: string): RegExp {
    if (choice === 'instant') return /\b(Instant|Fast)\b|즉시/i;
    if (choice === 'thinking') return /\b(Thinking|Think|Medium|High|Extra High)\b|중간|높음|매우 높음/i;
    if (choice === 'pro') return /\b(Pro|Heavy|Pro Standard|Pro Extended)\b|Pro 확장|프로 확장/i;
    return new RegExp(`(^|\\s)${escapeRegExp(label)}\\b`, 'i');
}

function effortLabelPattern(label: string): RegExp {
    return new RegExp(`(^|\\s)${escapeRegExp(label)}\\b`, 'i');
}

export function modelChoiceFromText(text: string): ChatGptModelChoice | null {
    // parity2 030 slice 3.2 (C-20): CJK terms use Han-script boundaries — \b is
    // meaningless for them ("GPT-5.5即时" must match; a bare "高" inside "极高" must not).
    if (/\b(Instant|Fast)\b|즉시|(?<!\p{Script=Han})即时(?!\p{Script=Han})/iu.test(text)) return 'instant';
    if (/\b(Pro Standard|Pro Extended)\b|Pro 확장|프로 확장|(?<!\p{Script=Han})Pro 扩展(?!\p{Script=Han})/iu.test(text)) return 'pro';
    if (/\b(Medium|High|Extra High)\b|중간|높음|매우 높음|(?<!\p{Script=Han})(思考|中等|极高|高)(?!\p{Script=Han})/iu.test(text)) return 'thinking';
    if (/\b(Thinking|Think)\b/i.test(text)) return 'thinking';
    if (/\b(Pro|Heavy)\b/i.test(text)) return 'pro';
    return null;
}

async function findOptionByExactLabels(page: Page, labels: readonly string[]): Promise<ReturnType<Page['locator']> | null> {
    for (const label of labels) {
        const candidates = await page.locator('[role="menuitemradio"], [role="menuitem"]').all().catch(() => []);
        for (const loc of candidates) {
            if (!(await loc.isVisible().catch(() => false))) continue;
            const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
            if (menuTextHasExactLine(text, label)) return loc;
        }
    }
    return null;
}

async function isSimplifiedIntelligenceMenuOpen(page: Page, model: ChatGptModelChoice | null, effort: ChatGptEffortChoice | null): Promise<boolean> {
    const requiredLabels = effort && model
        ? simplifiedEffortLabels(model, effort)
        : ['Instant', 'Medium', 'High', 'Extra High'];
    if (requiredLabels.length === 0) return false;
    return page.locator('[role="menu"]').evaluateAll((menus: BrowserNodeLike[], labels: readonly string[]) => menus.some(menu => {
        const text = menu.innerText || menu.textContent || '';
        if (!/\bIntelligence\b/i.test(text)) return false;
        return labels.some(label => menuTextHasExactLine(text, label));
    }), requiredLabels).catch(() => false);
}

function simplifiedDefaultLabels(model: ChatGptModelChoice): readonly string[] {
    return CHATGPT_SIMPLIFIED_INTELLIGENCE_OPTIONS[model]?.defaultLabels || [];
}

function simplifiedEffortLabels(model: ChatGptModelChoice, effort: ChatGptEffortChoice): readonly string[] {
    return CHATGPT_SIMPLIFIED_INTELLIGENCE_OPTIONS[model]?.efforts?.[effort] || [];
}

function effortChoiceFromSimplifiedText(text: string, model: ChatGptModelChoice, preferredEffort: ChatGptEffortChoice | null = null): ChatGptEffortChoice | null {
    const options = CHATGPT_SIMPLIFIED_INTELLIGENCE_OPTIONS[model]?.efforts || {};
    const preferredLabels = preferredEffort ? options[preferredEffort] || [] : [];
    if (preferredLabels.some(label => menuTextHasExactLine(text, label))) return preferredEffort;
    for (const [effort, labels] of Object.entries(options) as Array<[ChatGptEffortChoice, readonly string[]]>) {
        if (labels.some(label => menuTextHasExactLine(text, label))) return effort;
    }
    return null;
}

function menuTextHasExactLine(text: string, label: string): boolean {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => normalizeModelPickerText(line))
        .includes(normalizeModelPickerText(label));
}

export function normalizeModelPickerText(text: unknown): string {
    return String(text || '')
        .toLowerCase()
        // 104.6: Unicode-aware so Korean labels (즉시/중간/높음/…) survive normalization
        // instead of being stripped to '' (which made all pure-Korean labels collide).
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isModelPillText(text: string): boolean {
    return CHATGPT_MODEL_TEXT_BUTTON_PATTERN.test(text) || (CHATGPT_OBSERVED_PRO_PILL_LABELS as readonly string[]).includes(text);
}

function isStandaloneEffortLabel(text: string): boolean {
    return /^(Light|Standard|Extended|Heavy)$/i.test(String(text || '').trim());
}

function isLegacyProModelLabel(text: string): boolean {
    return /^\s*(Standard Pro|Extended Pro|Heavy)\s*$/i.test(text);
}

function escapeRegExp(value: string): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Power shell (parity2 030 slice 3.1, C-01) ───────────────────────────────
// The GPT-5.6 Chat picker renders a "Power" menu item whose 5-stop slider IS
// the tier/effort control: 0 Instant, 1 Medium, 2 High, 3 Extra High, 4 Pro.
// Menu rows may not exist at all on this shell, so selection must be able to
// fall back to driving the slider with keyboard arrows (agbrowse 45ec48a).

/** Slider stop → CJ effort vocabulary (standard=Medium, extended=High, heavy=Extra High). */
const CHATGPT_POWER_STOP_EFFORT: Readonly<Record<number, ChatGptEffortChoice>> = Object.freeze({
    1: 'standard',
    2: 'extended',
    3: 'heavy',
});

const CHATGPT_POWER_TIER_INDEX: Readonly<Record<ChatGptModelChoice, number>> = Object.freeze({
    instant: 0,
    thinking: 2,
    pro: 4,
});

const POWER_EFFORT_STOP_LABELS: Readonly<Record<ChatGptEffortChoice, readonly string[]>> = Object.freeze({
    light: ['Instant', '즉시', '即时'],
    standard: ['Medium', '중간', '中等'],
    extended: ['High', '높음', '高'],
    heavy: ['Extra High', '매우 높음', '极高'],
});

export async function isChatGptPowerPickerOpen(page: Page): Promise<boolean> {
    const root = page.locator(CHATGPT_POWER_PICKER_ROOT_SELECTOR).first();
    if (await root.isVisible().catch(() => false)) return true;
    const slider = page.locator(CHATGPT_POWER_SLIDER_VIEW_SELECTOR).first();
    return root === slider ? false : await slider.isVisible().catch(() => false);
}

/**
 * Resolve the thinking effort actually shown by a Power tier label. Label first
 * ("Extra High, 4 of 5."), aria-valuenow index as cross-check. Fails CLOSED:
 * when both are available and disagree, the effort is not verified.
 */
export function effortChoiceFromPowerTierLabel(label: string | null | undefined, index: number | null | undefined): ChatGptEffortChoice | null {
    const firstLine = String(label || '').split(/\r?\n/)[0] || '';
    const stripped = firstLine.replace(/,\s*\d+\s+of\s+\d+\.?$/i, '').trim();
    let fromLabel: ChatGptEffortChoice | null = null;
    for (const effort of ['standard', 'extended', 'heavy'] as const) {
        if (POWER_EFFORT_STOP_LABELS[effort].some(l => menuTextHasExactLine(stripped, l))) {
            fromLabel = effort;
            break;
        }
    }
    const hasIndex = Number.isFinite(index as number);
    const fromIndex = hasIndex ? (CHATGPT_POWER_STOP_EFFORT[index as number] ?? null) : null;
    if (fromLabel && hasIndex) return fromLabel === fromIndex ? fromLabel : null;
    return fromLabel || fromIndex;
}

function modelChoiceFromPowerSimpleText(text: string): ChatGptModelChoice | null {
    const first = String(text || '').split(/\r?\n/)[0] || '';
    // "High, 3 of 5." / "Pro, 5 of 5."
    const label = first.replace(/,\s*\d+\s+of\s+\d+\.?$/i, '').trim();
    if (/^(Pro|Pro 확장|프로 확장|Pro 扩展)/i.test(label)) return 'pro';
    if (/^(Instant|즉시|即时)/i.test(label)) return 'instant';
    if (/^(Thinking|Medium|High|Extra High|중간|높음|매우 높음|思考|中等|极高|高)/i.test(label)) return 'thinking';
    return modelChoiceFromText(label);
}

export async function readChatGptPowerSliderState(page: Page): Promise<{ index: number | null; choice: ChatGptModelChoice | null; label: string | null }> {
    const simple = page.locator('[data-testid="composer-model-picker-slider-simple-view"]').first();
    const simpleText = (await simple.innerText({ timeout: 500 }).catch(() => '')).trim();
    const choiceFromSimple = simpleText ? modelChoiceFromPowerSimpleText(simpleText) : null;
    const slider = page.locator(
        '[data-testid="composer-model-picker-slider-simple-view"] [role="slider"], [role="menu"][data-state="open"] [role="slider"]',
    ).first();
    const nowStr = await slider.getAttribute('aria-valuenow').catch(() => null);
    const index = nowStr != null && nowStr !== '' ? Number(nowStr) : null;
    if (choiceFromSimple) return { index: Number.isFinite(index as number) ? (index as number) : null, choice: choiceFromSimple, label: simpleText || choiceFromSimple };
    if (Number.isFinite(index as number)) {
        // 0 Instant, 1 Medium, 2 High, 3 Extra High, 4 Pro — middle three are thinking.
        const byIndex: ChatGptModelChoice[] = ['instant', 'thinking', 'thinking', 'thinking', 'pro'];
        const mapped = byIndex[index as number] || null;
        return { index: index as number, choice: mapped, label: simpleText || mapped };
    }
    return { index: null, choice: null, label: simpleText || null };
}

function powerTierIndexForChoice(choice: ChatGptModelChoice, effort: ChatGptEffortChoice | null = null): number {
    if (choice === 'instant') return CHATGPT_POWER_TIER_INDEX.instant;
    if (choice === 'pro') return CHATGPT_POWER_TIER_INDEX.pro;
    if (effort === 'standard') return 1;
    if (effort === 'heavy') return 3;
    if (effort === 'extended') return 2;
    return CHATGPT_POWER_TIER_INDEX.thinking;
}

/**
 * Drive the Chat Power slider with keyboard arrows until the shell reports the
 * requested choice (and effort stop for thinking). Returns true on success.
 */
export async function selectChatGptPowerTierBySlider(
    page: Page,
    choice: ChatGptModelChoice,
    options: { effort?: ChatGptEffortChoice | null; usedFallbacks?: string[] } = {},
): Promise<boolean> {
    if (!(await isChatGptPowerPickerOpen(page))) return false;
    const effort = options.effort || null;
    const usedFallbacks = options.usedFallbacks || [];
    const targetIndex = powerTierIndexForChoice(choice, effort);
    const power = page.locator('[role="menuitem"][aria-label="Power"]').first();
    if (!(await power.isVisible().catch(() => false))) return false;
    await power.focus({ timeout: 1_000 }).catch(() => undefined);
    await power.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150).catch(() => undefined);
    let stagnant = 0;
    let previousIndex: number | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const state = await readChatGptPowerSliderState(page);
        if (state.choice === choice) {
            if (choice !== 'thinking' || effort == null || state.index == null || state.index === targetIndex) {
                usedFallbacks.push('chat-power-slider');
                return true;
            }
        }
        const currentIndex = state.index != null ? state.index : (
            state.choice === 'instant' ? 0
                : state.choice === 'pro' ? 4
                    : 2
        );
        if (currentIndex === targetIndex && state.choice === choice) {
            usedFallbacks.push('chat-power-slider');
            return true;
        }
        if (previousIndex != null && previousIndex === currentIndex) stagnant += 1;
        else stagnant = 0;
        previousIndex = currentIndex;
        if (stagnant >= 2) break;
        const key = currentIndex > targetIndex ? 'ArrowLeft' : 'ArrowRight';
        await page.keyboard.press(key).catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
    }
    const finalState = await readChatGptPowerSliderState(page);
    if (finalState.choice === choice) {
        usedFallbacks.push('chat-power-slider');
        return true;
    }
    return false;
}
