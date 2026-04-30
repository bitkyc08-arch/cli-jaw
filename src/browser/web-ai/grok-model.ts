import type { Page } from 'playwright-core';

export type GrokModelChoice = 'auto' | 'fast' | 'expert' | 'grok-4.3' | 'heavy';

export interface GrokModelSelectionResult {
    requested: GrokModelChoice;
    selected: GrokModelChoice;
    alreadySelected: boolean;
    usedFallbacks: string[];
}

const GROK_MODEL_MENU_BUTTONS = [
    'button[aria-label="Model select"]',
    'button[aria-label*="Model select" i]',
] as const;

const GROK_MODEL_OPTIONS: Record<GrokModelChoice, { labels: string[] }> = {
    auto: { labels: ['Auto'] },
    fast: { labels: ['Fast'] },
    expert: { labels: ['Expert'] },
    'grok-4.3': { labels: ['Grok 4.3'] },
    heavy: { labels: ['Heavy'] },
};

const GROK_MODEL_ALIASES: Record<string, GrokModelChoice> = {
    auto: 'auto',
    automatic: 'auto',
    fast: 'fast',
    quick: 'fast',
    expert: 'expert',
    thinking: 'expert',
    think: 'expert',
    'grok-4.3': 'grok-4.3',
    'grok43': 'grok-4.3',
    'grok-43': 'grok-4.3',
    beta: 'grok-4.3',
    heavy: 'heavy',
};

export function normalizeGrokModelChoice(model: string | undefined): GrokModelChoice | null {
    const key = String(model || '').trim().toLowerCase();
    if (!key) return null;
    return GROK_MODEL_ALIASES[key] || null;
}

export async function selectGrokModel(page: Page, model: string | undefined): Promise<GrokModelSelectionResult | null> {
    const requested = normalizeGrokModelChoice(model);
    if (!requested) {
        if (model) throw new Error(`unsupported Grok model selection: ${model}`);
        return null;
    }
    const usedFallbacks: string[] = [];
    const before = await readGrokModel(page);
    if (before === requested) {
        return { requested, selected: before, alreadySelected: true, usedFallbacks };
    }
    await openGrokModelMenu(page, usedFallbacks);
    const option = await findGrokModelOption(page, requested);
    if (!option) throw new Error(`Grok model option not found: ${requested}`);
    await option.click({ timeout: 5_000 });
    await page.waitForTimeout(700).catch(() => undefined);
    const after = await readGrokModel(page);
    if (after !== requested) {
        throw new Error(`Grok model verification failed: expected ${requested}, got ${after || 'none'}`);
    }
    return { requested, selected: after, alreadySelected: false, usedFallbacks };
}

async function openGrokModelMenu(page: Page, usedFallbacks: string[]): Promise<void> {
    if (await page.locator('[role="menuitem"]').filter({ hasText: /^Auto\b|^Fast\b|^Expert\b|^Grok 4\.3\b|^Heavy\b/i }).first().isVisible().catch(() => false)) return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        for (const selector of GROK_MODEL_MENU_BUTTONS) {
            const loc = page.locator(selector).first();
            if (!(await loc.isVisible().catch(() => false))) continue;
            await loc.click({ timeout: 5_000 });
            await page.waitForTimeout(350).catch(() => undefined);
            if (await page.locator('[role="menuitem"]').filter({ hasText: /^Auto\b|^Fast\b|^Expert\b|^Grok 4\.3\b|^Heavy\b/i }).first().isVisible().catch(() => false)) return;
        }
        await page.waitForTimeout(150).catch(() => undefined);
    }
    usedFallbacks.push('model-menu-text-button');
    const textButton = page.locator('button').filter({ hasText: /^Auto$|^Fast$|^Expert$|^Grok 4\.3|^Heavy$/i }).first();
    if (await textButton.isVisible().catch(() => false)) {
        await textButton.click({ timeout: 5_000 });
        await page.waitForTimeout(350).catch(() => undefined);
        if (await page.locator('[role="menuitem"]').first().isVisible().catch(() => false)) return;
    }
    throw new Error(`Grok model selector not found. Tried: ${GROK_MODEL_MENU_BUTTONS.join(', ')}`);
}

async function findGrokModelOption(page: Page, choice: GrokModelChoice): Promise<ReturnType<Page['locator']> | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const candidates = await page.locator('[role="menuitem"], button').all().catch(() => []);
        for (const label of GROK_MODEL_OPTIONS[choice].labels) {
            const pattern = new RegExp(`^${escapeRegExp(label)}\\b`, 'i');
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

async function readGrokModel(page: Page): Promise<GrokModelChoice | null> {
    for (const selector of GROK_MODEL_MENU_BUTTONS) {
        const loc = page.locator(selector).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        return normalizeGrokModelChoice(await loc.innerText({ timeout: 1_000 }).catch(() => ''));
    }
    return null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
