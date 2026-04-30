import type { Page } from 'playwright-core';

export type GeminiModelChoice = 'fast' | 'thinking' | 'pro';

export interface GeminiModelSelectionResult {
    requested: GeminiModelChoice;
    selected: GeminiModelChoice;
    alreadySelected: boolean;
    usedFallbacks: string[];
}

const GEMINI_MODE_MENU_BUTTONS = [
    'button[data-test-id="bard-mode-menu-button"]',
    'button[aria-label="Open mode picker"]',
    'button[aria-label*="mode picker" i]',
] as const;

const GEMINI_MODE_OPTIONS: Record<GeminiModelChoice, { testId: string; labels: string[] }> = {
    fast: { testId: 'bard-mode-option-fast', labels: ['Fast'] },
    thinking: { testId: 'bard-mode-option-thinking', labels: ['Thinking'] },
    pro: { testId: 'bard-mode-option-pro', labels: ['Pro'] },
};

const GEMINI_MODEL_ALIASES: Record<string, GeminiModelChoice> = {
    fast: 'fast',
    flash: 'fast',
    'gemini-fast': 'fast',
    thinking: 'thinking',
    think: 'thinking',
    'gemini-thinking': 'thinking',
    pro: 'pro',
    'gemini-pro': 'pro',
    '3.1-pro': 'pro',
};

export function normalizeGeminiModelChoice(model: string | undefined): GeminiModelChoice | null {
    const key = String(model || '').trim().toLowerCase();
    if (!key) return null;
    return GEMINI_MODEL_ALIASES[key] || null;
}

export async function selectGeminiModel(page: Page, model: string | undefined): Promise<GeminiModelSelectionResult | null> {
    const requested = normalizeGeminiModelChoice(model);
    if (!requested) {
        if (model) throw new Error(`unsupported Gemini model selection: ${model}`);
        return null;
    }
    const usedFallbacks: string[] = [];
    const before = await readGeminiModel(page);
    if (before === requested) {
        return { requested, selected: before, alreadySelected: true, usedFallbacks };
    }
    await openGeminiModelMenu(page, usedFallbacks);
    const option = await findGeminiModelOption(page, requested);
    if (!option) throw new Error(`Gemini model option not found: ${requested}`);
    await option.click({ timeout: 5_000 });
    await page.waitForTimeout(700).catch(() => undefined);
    const after = await readGeminiModel(page);
    if (after !== requested) {
        throw new Error(`Gemini model verification failed: expected ${requested}, got ${after || 'none'}`);
    }
    return { requested, selected: after, alreadySelected: false, usedFallbacks };
}

async function openGeminiModelMenu(page: Page, usedFallbacks: string[]): Promise<void> {
    if (await page.locator('[data-test-id^="bard-mode-option-"], [role="menuitem"]').filter({ hasText: /^Fast\b|^Thinking\b|^Pro\b/i }).first().isVisible().catch(() => false)) return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        for (const selector of GEMINI_MODE_MENU_BUTTONS) {
            const loc = page.locator(selector).first();
            if (!(await loc.isVisible().catch(() => false))) continue;
            await loc.click({ timeout: 5_000 });
            await page.waitForTimeout(350).catch(() => undefined);
            if (await page.locator('[data-test-id^="bard-mode-option-"], [role="menuitem"]').filter({ hasText: /^Fast\b|^Thinking\b|^Pro\b/i }).first().isVisible().catch(() => false)) return;
        }
        await page.waitForTimeout(150).catch(() => undefined);
    }
    usedFallbacks.push('mode-menu-text-button');
    const textButton = page.locator('button').filter({ hasText: /^Fast$|^Thinking$|^Pro$/i }).first();
    if (await textButton.isVisible().catch(() => false)) {
        await textButton.click({ timeout: 5_000 });
        await page.waitForTimeout(350).catch(() => undefined);
        if (await page.locator('[data-test-id^="bard-mode-option-"], [role="menuitem"]').first().isVisible().catch(() => false)) return;
    }
    throw new Error(`Gemini mode selector not found. Tried: ${GEMINI_MODE_MENU_BUTTONS.join(', ')}`);
}

async function findGeminiModelOption(page: Page, choice: GeminiModelChoice): Promise<ReturnType<Page['locator']> | null> {
    const option = GEMINI_MODE_OPTIONS[choice];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const byTestId = page.locator(`[data-test-id="${option.testId}"]`).first();
        if (await byTestId.isVisible().catch(() => false)) return byTestId;
        const candidates = await page.locator('[role="menuitem"], button').all().catch(() => []);
        for (const label of option.labels) {
            const pattern = new RegExp(`^${label}\\b`, 'i');
            for (const candidate of candidates) {
                if (!(await candidate.isVisible().catch(() => false))) continue;
                const text = (await candidate.innerText({ timeout: 500 }).catch(() => '')).trim().replace(/\s+/g, ' ');
                if (pattern.test(text)) return candidate;
            }
        }
        await page.waitForTimeout(150).catch(() => undefined);
    }
    return null;
}

async function readGeminiModel(page: Page): Promise<GeminiModelChoice | null> {
    for (const selector of GEMINI_MODE_MENU_BUTTONS) {
        const loc = page.locator(selector).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        return normalizeGeminiModelChoice(await loc.innerText({ timeout: 1_000 }).catch(() => ''));
    }
    return null;
}
