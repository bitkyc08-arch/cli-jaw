import { createHash } from 'node:crypto';

declare const document: any;

export interface PageLike {
    evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface DomHashOptions {
    maxChars?: number;
}

export interface SelectorMatch {
    selector: string;
    matched: number;
    visible: boolean;
}

export async function domHashAround(
    page: PageLike,
    selectors: string[],
    options: DomHashOptions = {},
): Promise<string | null> {
    const maxChars = options.maxChars ?? 8192;
    const html = await page.evaluate((sels: string[]) => {
        for (const s of sels) {
            try {
                const n = document.querySelector(s);
                if (n) return n.outerHTML;
            } catch {
                // invalid selector
            }
        }
        return null;
    }, selectors).catch(() => null);
    if (!html) return null;
    return `sha256:${createHash('sha256').update(normalizeDomForHash(html).slice(0, maxChars)).digest('hex').slice(0, 16)}`;
}

export function normalizeDomForHash(html: string): string {
    return String(html)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(\w+)\s[^>]*>/g, '<$1>')
        .replace(/>([^<]+)</g, '><')
        .replace(/\s+/g, ' ')
        .trim();
}

export interface LocatorLike {
    count(): Promise<number>;
    nth(index: number): LocatorLike;
    isVisible(): Promise<boolean>;
}

export interface PageWithLocator extends PageLike {
    locator(selector: string): LocatorLike;
}

export async function selectorMatchSummary(
    page: PageWithLocator,
    selectors: string[],
): Promise<SelectorMatch[]> {
    const MAX_VISIBILITY_SCAN = 10;
    return Promise.all(selectors.map(async selector => {
        const loc = page.locator(selector);
        const matched = await loc.count().catch(() => 0);
        let visible = false;
        for (let i = 0; i < Math.min(matched, MAX_VISIBILITY_SCAN) && !visible; i += 1) {
            visible = await loc.nth(i).isVisible().catch(() => false);
        }
        return { selector, matched, visible };
    }));
}
