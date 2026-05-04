import type { Page } from 'playwright-core';

declare const document: any;

export type ChatGptModelChoice = 'instant' | 'thinking' | 'pro';
export type ChatGptEffortChoice = 'light' | 'standard' | 'extended' | 'heavy';

export interface ChatGptModelSelectionResult {
    requested: ChatGptModelChoice;
    selected: ChatGptModelChoice;
    alreadySelected: boolean;
    effort?: ChatGptEffortChoice | null;
    requestedEffort?: ChatGptEffortChoice | null;
    usedFallbacks: string[];
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

const CHATGPT_MODEL_MENU_ITEM_SELECTOR = '[data-testid^="model-switcher-"]';
const CHATGPT_MODEL_TEXT_BUTTON_PATTERN = /^(ChatGPT|GPT[-\s]?\d|((Light|Standard|Extended|Heavy)\s+)?(Instant|Fast|Thinking|Pro|Heavy)\b)/i;
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
    instant: { testIds: ['model-switcher-gpt-5-3'], labels: ['Instant'] },
    thinking: { testIds: ['model-switcher-gpt-5-5-thinking', 'model-switcher-gpt-5-5-thinking-thinking-effort'], labels: ['Thinking'] },
    pro: { testIds: ['model-switcher-gpt-5-5-pro', 'model-switcher-gpt-5-5-pro-thinking-effort'], labels: ['Pro', 'Heavy'] },
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

const MODEL_ALIASES: Record<string, ChatGptModelChoice> = {
    instant: 'instant',
    fast: 'instant',
    'gpt-5-3': 'instant',
    'gpt-5.3': 'instant',
    thinking: 'thinking',
    think: 'thinking',
    'gpt-5-5-thinking': 'thinking',
    'gpt-5.5-thinking': 'thinking',
    pro: 'pro',
    'gpt-5-5-pro': 'pro',
    'gpt-5.5-pro': 'pro',
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
    const requestedModel = normalizeChatGptModelChoice(model) || model;
    const requestedEffort = normalizeChatGptEffortChoice(effort) || effort;
    return Boolean((CHATGPT_MODEL_EFFORT_OPTIONS as Record<string, any>)[String(requestedModel)]?.efforts?.[String(requestedEffort)]);
}

export async function selectChatGptModel(page: Page, model: string | undefined, options: { effort?: string; reasoningEffort?: string } = {}): Promise<ChatGptModelSelectionResult | null> {
    const requested = normalizeChatGptModelChoice(model);
    const requestedEffort = normalizeChatGptEffortChoice(options.effort || options.reasoningEffort);
    if (!requested) {
        if (model) throw new Error(`unsupported ChatGPT model selection: ${model}`);
        if (!requestedEffort) return null;
    }
    if ((options.effort || options.reasoningEffort) && !requestedEffort) {
        throw new Error(`unsupported ChatGPT reasoning effort: ${options.effort || options.reasoningEffort}`);
    }

    const usedFallbacks: string[] = [];
    await openModelMenu(page, usedFallbacks);
    let currentModel = await readCheckedModel(page);
    const targetModel = requested || currentModel;
    let modelChanged = false;
    if (!targetModel) {
        await closeModelMenu(page);
        throw new Error('ChatGPT model must be selected before setting reasoning effort');
    }
    if (requested && currentModel !== requested) {
        const option = await findModelOption(page, requested);
        if (!option) throw new Error(`ChatGPT model option not found: ${requested}`);
        await option.click({ timeout: 5_000 });
        await page.waitForTimeout(750).catch(() => undefined);
        await openModelMenu(page, usedFallbacks);
        currentModel = await readCheckedModel(page);
        modelChanged = true;
    }

    let selectedEffort: { selected: ChatGptEffortChoice; changed: boolean } | null = null;
    if (requestedEffort) {
        selectedEffort = await selectChatGptEffort(page, targetModel, requestedEffort, usedFallbacks);
        await openModelMenu(page, usedFallbacks);
    }
    const after = await readCheckedModel(page);
    await closeModelMenu(page);
    if (after !== targetModel) throw new Error(`ChatGPT model verification failed: expected ${targetModel}, got ${after || 'none'}`);
    return {
        requested: requested || targetModel,
        selected: after,
        alreadySelected: !modelChanged && !selectedEffort?.changed,
        effort: selectedEffort?.selected || null,
        requestedEffort: requestedEffort || null,
        usedFallbacks,
    };
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
    const textButton = page.locator('button').filter({ hasText: /^ChatGPT$|^GPT-|^Instant$|^Fast$|^Thinking$|^Pro$|^Heavy$|^Extended Pro$|^Standard Pro$/i }).first();
    if (await textButton.isVisible().catch(() => false)) {
        await textButton.click({ timeout: 5_000 });
        await page.waitForTimeout(400).catch(() => undefined);
        if (await isModelMenuOpen(page)) return;
    }
    throw new Error(`ChatGPT model selector not found. Tried: ${[...CHATGPT_MODEL_SELECTOR_BUTTONS, ...CHATGPT_COMPOSER_MODEL_PILL_SELECTORS].join(', ')}`);
}

async function findComposerModelPill(page: Page): Promise<ReturnType<Page['locator']> | null> {
    for (const selector of CHATGPT_COMPOSER_MODEL_PILL_SELECTORS) {
        const candidates = await page.locator(selector).count().catch(() => 0);
        for (let index = candidates - 1; index >= 0; index -= 1) {
            const loc = page.locator(selector).nth(index);
            if (!(await loc.isVisible().catch(() => false))) continue;
            const text = await loc.innerText({ timeout: 1_000 }).catch(() => '');
            if (CHATGPT_MODEL_TEXT_BUTTON_PATTERN.test(text.trim())) return loc;
        }
    }
    const textButton = page.locator('button').filter({ hasText: CHATGPT_MODEL_TEXT_BUTTON_PATTERN }).last();
    if (await textButton.isVisible().catch(() => false)) return textButton;
    return null;
}

async function findModelOption(page: Page, choice: ChatGptModelChoice): Promise<ReturnType<Page['locator']> | null> {
    const option = CHATGPT_MODEL_OPTIONS[choice];
    for (const testId of option.testIds) {
        const loc = page.locator(`[role="menuitemradio"][data-testid="${testId}"], [data-testid="${testId}"]`).first();
        if (await loc.isVisible().catch(() => false)) return loc;
    }
    for (const label of option.labels) {
        const loc = page.locator('[role="menuitemradio"], [role="menuitem"]').filter({ hasText: modelLabelPattern(choice, label) }).first();
        if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
}

async function selectChatGptEffort(page: Page, model: ChatGptModelChoice, effort: ChatGptEffortChoice, usedFallbacks: string[]): Promise<{ selected: ChatGptEffortChoice; changed: boolean }> {
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    if (!config?.efforts?.[effort]) throw new Error(`ChatGPT reasoning effort ${effort} is not available for ${model}`);
    await openEffortMenu(page, model, usedFallbacks);
    const before = await readCheckedEffort(page, model);
    if (before === effort) return { selected: before, changed: false };
    const option = await findEffortOption(page, model, effort);
    if (!option) throw new Error(`ChatGPT reasoning effort option not found: ${model}/${effort}`);
    await option.click({ timeout: 5_000 });
    await page.waitForTimeout(500).catch(() => undefined);
    await openEffortMenu(page, model, usedFallbacks);
    const after = await readCheckedEffort(page, model);
    if (after !== effort) throw new Error(`ChatGPT reasoning effort verification failed: expected ${effort}, got ${after || 'none'}`);
    return { selected: after, changed: true };
}

async function findEffortOption(page: Page, model: ChatGptModelChoice, effort: ChatGptEffortChoice): Promise<ReturnType<Page['locator']> | null> {
    const label = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro']?.efforts?.[effort];
    if (!label) return null;
    const candidates = page.locator('[role="menuitemradio"]').filter({ hasText: effortLabelPattern(label) });
    const modelSpecific = candidates.filter({ hasText: modelLabelPattern(model, CHATGPT_MODEL_OPTIONS[model]?.labels?.[0] || '') }).last();
    if (await modelSpecific.isVisible().catch(() => false)) return modelSpecific;
    const option = candidates.last();
    return (await option.isVisible().catch(() => false)) ? option : null;
}

async function openEffortMenu(page: Page, model: ChatGptModelChoice, usedFallbacks: string[]): Promise<void> {
    if (await isEffortMenuOpen(page, model)) return;
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
        const box = await elementRectByTestId(page, testId);
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
            await page.waitForTimeout(100).catch(() => undefined);
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
            await page.waitForTimeout(300).catch(() => undefined);
            if (await isEffortMenuOpen(page, model)) return;
        }
        await trigger.click({ timeout: 5_000 });
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model)) return;
    }
    for (const selector of CHATGPT_EFFORT_TRIGGER_SELECTORS) {
        const trigger = page.locator(selector).last();
        if (!(await trigger.isVisible().catch(() => false))) continue;
        await trigger.click({ timeout: 2_000 }).catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model)) {
            usedFallbacks.push(`${model}-effort-generic-trigger`);
            return;
        }
    }
    if (row) {
        await row.focus({ timeout: 1_000 }).catch(() => undefined);
        await page.keyboard.press('ArrowRight').catch(() => undefined);
        await page.waitForTimeout(300).catch(() => undefined);
        if (await isEffortMenuOpen(page, model)) {
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
        if (await isEffortMenuOpen(page, model)) {
            usedFallbacks.push(`${model}-effort-row-button`);
            return;
        }
    }
    usedFallbacks.push(`${model}-effort-trigger`);
    throw new Error(`ChatGPT reasoning effort selector not found for ${model}`);
}

async function findEffortTriggerBoxNearModelRow(page: Page, model: ChatGptModelChoice): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const labels = CHATGPT_MODEL_OPTIONS[model]?.labels || [];
    return page.evaluate(({ expectedLabels, modelChoice, triggerSelectors }: { expectedLabels: string[]; modelChoice: ChatGptModelChoice; triggerSelectors: readonly string[] }) => {
        const rows = Array.from(document.querySelectorAll('[role="menuitemradio"][data-testid^="model-switcher-"], [role="menuitemradio"]')) as any[];
        const row = rows.find((candidate) => {
            const text = (candidate.innerText || candidate.textContent || '').trim();
            return matchesModelText(text, modelChoice, expectedLabels);
        });
        if (!row) return null;
        const rowRect = row.getBoundingClientRect();
        const effortButtons = Array.from(document.querySelectorAll(triggerSelectors.join(','))) as any[];
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

async function elementRectByTestId(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return page.evaluate((id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, testId).catch(() => null);
}

async function readCheckedEffort(page: Page, model: ChatGptModelChoice): Promise<ChatGptEffortChoice | null> {
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    for (const [effort, label] of Object.entries(config?.efforts || {}) as Array<[ChatGptEffortChoice, string]>) {
        const checked = await page.locator('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"][data-state="checked"]')
            .filter({ hasText: effortLabelPattern(label) })
            .last()
            .isVisible()
            .catch(() => false);
        if (checked) return effort;
    }
    const active = await readActiveModelPill(page);
    for (const [effort, label] of Object.entries(config?.efforts || {}) as Array<[ChatGptEffortChoice, string]>) {
        if (effortLabelPattern(label).test(active)) return effort;
    }
    return null;
}

async function isEffortMenuOpen(page: Page, model: ChatGptModelChoice): Promise<boolean> {
    const config = CHATGPT_MODEL_EFFORT_OPTIONS[model as 'thinking' | 'pro'];
    if (!config) return false;
    const labels = Object.values(config.efforts).filter(Boolean) as string[];
    const unexpectedLabels = Object.entries(CHATGPT_MODEL_EFFORT_OPTIONS)
        .filter(([choice]) => choice !== model)
        .flatMap(([, option]) => Object.values(option.efforts))
        .filter((label): label is string => Boolean(label) && !labels.includes(label));
    return page.locator('[role="menu"]').evaluateAll((menus, { expectedLabels, unexpectedLabels, modelChoice }: { expectedLabels: string[]; unexpectedLabels: string[]; modelChoice: ChatGptModelChoice }) => {
        return menus.some(menu => {
            const text = (menu as any).innerText || menu.textContent || '';
            if (!menuTextMatchesModel(text, modelChoice)) return false;
            const unexpectedMatches = unexpectedLabels.filter(label => new RegExp(`(^|\\s)${label}(\\s|$)`, 'i').test(text));
            if (unexpectedMatches.length > 0) return false;
            const matches = expectedLabels.filter(label => new RegExp(`(^|\\s)${label}(\\s|$)`, 'i').test(text));
            const requiredMatches = expectedLabels.length <= 2 ? expectedLabels.length : Math.min(3, expectedLabels.length);
            return matches.length >= requiredMatches;
        });
        function menuTextMatchesModel(text: string, choice: ChatGptModelChoice): boolean {
            const hasThinking = /\b(Thinking|Think)\b/i.test(text);
            const hasPro = /\bPro\b/i.test(text);
            if (!hasThinking && !hasPro) return true;
            if (choice === 'thinking') return hasThinking && !hasPro;
            if (choice === 'pro') return hasPro && !hasThinking;
            return true;
        }
    }, { expectedLabels: labels, unexpectedLabels, modelChoice: model }).catch(() => false);
}

async function readCheckedModel(page: Page): Promise<ChatGptModelChoice | null> {
    for (const [choice, option] of Object.entries(CHATGPT_MODEL_OPTIONS) as Array<[ChatGptModelChoice, typeof CHATGPT_MODEL_OPTIONS[ChatGptModelChoice]]>) {
        for (const testId of option.testIds) {
            const checked = await page.locator(`[role="menuitemradio"][data-testid="${testId}"][aria-checked="true"], [data-testid="${testId}"][aria-checked="true"]`).first().isVisible().catch(() => false);
            if (checked) return choice;
        }
    }
    const checkedRows = await page.locator('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"][data-state="checked"]').all().catch(() => []);
    for (const row of checkedRows) {
        const text = (await row.innerText({ timeout: 500 }).catch(() => '')).trim();
        const choice = modelChoiceFromText(text);
        if (choice) return choice;
    }
    const active = await readActiveModelPill(page);
    return modelChoiceFromText(active);
}

async function readActiveModelPill(page: Page): Promise<string> {
    const candidates = await page.locator('button').count().catch(() => 0);
    for (let index = candidates - 1; index >= 0; index -= 1) {
        const loc = page.locator('button').nth(index);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const text = (await loc.innerText({ timeout: 500 }).catch(() => '')).trim();
        if (CHATGPT_MODEL_TEXT_BUTTON_PATTERN.test(text)) return text;
    }
    return '';
}

async function isModelMenuOpen(page: Page): Promise<boolean> {
    return page.locator(CHATGPT_MODEL_MENU_ITEM_SELECTOR).first().isVisible().catch(() => false);
}

function modelLabelPattern(choice: ChatGptModelChoice, label: string): RegExp {
    if (choice === 'instant') return /\b(Instant|Fast)\b/i;
    if (choice === 'thinking') return /\b(Thinking|Think)\b/i;
    if (choice === 'pro') return /\b(Pro|Heavy)\b/i;
    return new RegExp(`(^|\\s)${escapeRegExp(label)}\\b`, 'i');
}

function effortLabelPattern(label: string): RegExp {
    return new RegExp(`(^|\\s)${escapeRegExp(label)}\\b`, 'i');
}

function modelChoiceFromText(text: string): ChatGptModelChoice | null {
    if (/\b(Instant|Fast)\b/i.test(text)) return 'instant';
    if (/\b(Thinking|Think)\b/i.test(text)) return 'thinking';
    if (/\b(Pro|Heavy)\b/i.test(text)) return 'pro';
    return null;
}

function escapeRegExp(value: string): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
