import type { Locator, Page } from 'playwright-core';

/**
 * ChatGPT assistant-turn DOM readers with descendant de-duplication. Strict-TS port of
 * agbrowse web-ai/chatgpt-response-dom.mjs (parity catalog 106.13) — a nested assistant
 * match must never double-count its parent's text.
 */

export const CHATGPT_ASSISTANT_SELECTORS: string[] = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];

export const CHATGPT_STOP_SELECTORS: string[] = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
];

/**
 * Browser-context helper. Keep self-contained so Playwright can serialize it into
 * page.evaluate without relying on module closures.
 */
export function readTopLevelAssistantTexts(selectors: string[]): string[] {
    const activeSelectors = Array.isArray(selectors) && selectors.length
        ? selectors
        : [
            '[data-message-author-role="assistant"]',
            '[data-turn="assistant"]',
            'article[data-testid^="conversation-turn"]',
        ];
    const isInsideAnotherMatchedNode = (el: Element, matched: Element[]): boolean =>
        matched.some((other) => other !== el && typeof other.contains === 'function' && other.contains(el));

    for (const selector of activeSelectors) {
        const matched = Array.from(document.querySelectorAll(selector));
        const topLevel = matched.filter((el) => !isInsideAnotherMatchedNode(el, matched));
        const texts = topLevel
            .map((el) => String((el as HTMLElement).innerText || el.textContent || '').trim())
            .filter(Boolean);
        if (texts.length) return texts;
    }
    return [];
}

/**
 * Fallback for environments where page.evaluate fails but Playwright locators still
 * work. Applies the same descendant de-duplication rule as readTopLevelAssistantTexts.
 */
export async function readTopLevelAssistantTextsFromLocators(
    page: Page,
    selectors: string[] = CHATGPT_ASSISTANT_SELECTORS,
): Promise<string[]> {
    for (const selector of selectors) {
        const locators: Locator[] = await page.locator(selector).all().catch(() => []);
        const texts: string[] = [];
        for (const locator of locators) {
            const text = await locator.evaluate((node: Element, activeSelector: string) => {
                const matched = Array.from(document.querySelectorAll(activeSelector));
                const nested = matched.some((other) =>
                    other !== node && typeof other.contains === 'function' && other.contains(node));
                if (nested) return '';
                return String((node as HTMLElement).innerText || node.textContent || '').trim();
            }, selector).catch(() => '');
            const trimmed = String(text || '').trim();
            if (trimmed) texts.push(trimmed);
        }
        if (texts.length) return texts;
    }
    return [];
}
