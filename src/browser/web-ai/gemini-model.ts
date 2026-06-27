import type { Page } from 'playwright-core';
import type { CapabilityProbeResult } from './capability-probe.js';

export type GeminiModelChoice = 'flash-lite' | 'flash' | 'pro';

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

const GEMINI_MODE_OPTION_SELECTOR = '[data-test-id^="bard-mode-option-"], [role="menuitem"], [role="option"]';

const GEMINI_MODE_OPTIONS: Record<GeminiModelChoice, { testId: string; labels: string[] }> = {
    'flash-lite': { testId: 'bard-mode-option-fast', labels: ['Flash-Lite', 'Flash Lite'] },
    flash: { testId: 'bard-mode-option-thinking', labels: ['Flash'] },
    pro: { testId: 'bard-mode-option-pro', labels: ['Pro'] },
};

const GEMINI_DEEP_THINK_ALIASES = new Set([
    'deepthink',
    'deep-think',
    'deep_think',
    'deep think',
    'gemini-deepthink',
    'gemini-deep-think',
]);

const GEMINI_MODEL_ALIASES: Record<string, GeminiModelChoice> = {
    fast: 'flash-lite',
    'flash-lite': 'flash-lite',
    'flash_lite': 'flash-lite',
    'flash lite': 'flash-lite',
    'gemini-fast': 'flash-lite',
    'gemini-flash-lite': 'flash-lite',
    'gemini-flash_lite': 'flash-lite',
    'gemini flash lite': 'flash-lite',
    flash: 'flash',
    'gemini-flash': 'flash',
    thinking: 'pro',
    think: 'pro',
    'gemini-thinking': 'pro',
    pro: 'pro',
    'gemini-pro': 'pro',
};

export function normalizeGeminiModelChoice(model: string | undefined): GeminiModelChoice | null {
    const key = String(model || '').trim().toLowerCase();
    if (!key) return null;
    return GEMINI_MODEL_ALIASES[key] || normalizeGeminiModelLabel(key);
}

export function isGeminiDeepThinkChoice(model: string | undefined): boolean {
    const key = String(model || '').trim().toLowerCase();
    return GEMINI_DEEP_THINK_ALIASES.has(key);
}

export async function selectGeminiModel(page: Page, model: string | undefined): Promise<GeminiModelSelectionResult | null> {
    if (isGeminiDeepThinkChoice(model)) return null;
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
    const modeItems = page.locator(GEMINI_MODE_OPTION_SELECTOR)
        .filter({ hasText: /Flash|Pro|Thinking/i });
    if (await modeItems.first().isVisible().catch(() => false)) return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        for (const selector of GEMINI_MODE_MENU_BUTTONS) {
            const loc = page.locator(selector).first();
            if (!(await loc.isVisible().catch(() => false))) continue;
            await loc.click({ timeout: 5_000 });
            await page.waitForTimeout(350).catch(() => undefined);
            if (await modeItems.first().isVisible().catch(() => false)) return;
        }
        await page.waitForTimeout(150).catch(() => undefined);
    }
    usedFallbacks.push('mode-menu-text-button');
    const textButton = page.locator('button').filter({ hasText: /Flash|Pro|Thinking/i }).first();
    if (await textButton.isVisible().catch(() => false)) {
        await textButton.click({ timeout: 5_000 });
        await page.waitForTimeout(350).catch(() => undefined);
        if (await modeItems.first().isVisible().catch(() => false)) return;
    }
    throw new Error(`Gemini mode selector not found. Tried: ${GEMINI_MODE_MENU_BUTTONS.join(', ')}`);
}

async function findGeminiModelOption(page: Page, choice: GeminiModelChoice): Promise<ReturnType<Page['locator']> | null> {
    const option = GEMINI_MODE_OPTIONS[choice];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const byTestId = page.locator(`[data-test-id="${option.testId}"]`).first();
        if (await byTestId.isVisible().catch(() => false)) return byTestId;
        const candidates = await page.locator(GEMINI_MODE_OPTION_SELECTOR).all().catch(() => []);
        for (const label of option.labels) {
            const pattern = geminiModeLabelPattern(label);
            for (const candidate of candidates) {
                if (!(await candidate.isVisible().catch(() => false))) continue;
                const labelEl = candidate.locator('.label').first();
                const text = await labelEl.isVisible().catch(() => false)
                    ? (await labelEl.innerText({ timeout: 500 }).catch(() => '')).trim().replace(/\s+/g, ' ')
                    : (await candidate.innerText({ timeout: 500 }).catch(() => '')).trim().replace(/\s+/g, ' ');
                if (pattern.test(text)) return candidate;
            }
            const byText = page.getByText(pattern).first();
            if (await byText.isVisible().catch(() => false)) return byText;
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

// 104.9: read-only probe — close any menu we open and never mutate the selection.
async function closeGeminiModelMenu(page: Page): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        const menuVisible = await page.locator(GEMINI_MODE_OPTION_SELECTOR)
            .filter({ hasText: /Flash|Pro|Thinking/i }).first().isVisible().catch(() => false);
        if (!menuVisible) return;
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
    }
}

/**
 * 104.9: read-only Gemini model capability probe with a fallback ladder.
 * Reports whether the requested model is already active ('ok'), selectable but not
 * active ('warn'), or unavailable ('fail') — without ever changing the selection.
 */
export async function geminiModelCapabilityProbe(page: Page, model: string | undefined): Promise<CapabilityProbeResult> {
    if (isGeminiDeepThinkChoice(model)) {
        return { state: 'unknown', evidence: { requested: model, tool: 'deepthink' }, next: 'send' };
    }
    if (!model) return { state: 'unknown', evidence: { requested: null }, next: 'send' };
    const requested = normalizeGeminiModelChoice(model);
    if (!requested) return { state: 'fail', evidence: { requested: model }, next: 'model-fallback' };
    const active = await readGeminiModel(page).catch(() => null);
    if (active === requested) return { state: 'ok', evidence: { active, requested, selectable: true }, next: 'send' };
    const usedFallbacks: string[] = [];
    try {
        await openGeminiModelMenu(page, usedFallbacks);
    } catch {
        return { state: 'warn', evidence: { active, requested, menuOpenFailed: true, usedFallbacks }, next: 'model-fallback' };
    }
    const option = await findGeminiModelOption(page, requested).catch(() => null);
    await closeGeminiModelMenu(page);
    return option
        ? { state: 'warn', evidence: { active, requested, selectable: true, usedFallbacks }, next: 'model-fallback' }
        : { state: 'fail', evidence: { active, requested, selectable: false, usedFallbacks }, next: 'model-fallback' };
}

function geminiModeLabelPattern(label: string): RegExp {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[- ]');
    return new RegExp(`^(?:Gemini\\s*)?(?:\\d+(?:\\.\\d+)?\\s+)?${escaped}(?![\\w-])`, 'i');
}

function normalizeGeminiModelLabel(label: string): GeminiModelChoice | null {
    const normalized = String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    const withoutVendor = normalized.replace(/^gemini\s+/, '');
    const withoutVersion = withoutVendor.replace(/^\d+(?:\.\d+)?\s+/, '');
    if (/^flash[ -]lite(?![\w-])/.test(withoutVersion)) return 'flash-lite';
    if (/^flash(?![\w-])/.test(withoutVersion)) return 'flash';
    if (/^pro(?![\w-])/.test(withoutVersion)) return 'pro';
    return null;
}
