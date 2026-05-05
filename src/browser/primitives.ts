import { stripUndefined } from '../core/strip-undefined.js';

type BoxLike = { width: number; height: number };
type StyleLike = { display?: string; visibility?: string; opacity?: string };
type VisibleNodeLike = { getBoundingClientRect?: () => BoxLike };
type TextNodeLike = { innerText?: string; textContent?: string };

export interface BrowserLocatorLike {
    waitFor?(options: { state: 'visible'; timeout: number }): Promise<unknown>;
    boundingBox?(): Promise<BoxLike | null>;
    evaluate?(fn: (node: VisibleNodeLike) => boolean): Promise<boolean>;
    innerText?(): Promise<string>;
    count?(): Promise<number>;
    all?(): Promise<BrowserLocatorLike[]>;
    nth?(index: number): BrowserLocatorLike;
    first?(): BrowserLocatorLike;
}

export interface BrowserPageLike {
    locator(selector: string): BrowserLocatorLike;
    waitForTimeout?(timeoutMs: number): Promise<unknown>;
    evaluate?(fn: (innerSelectors: readonly string[]) => string[], arg: readonly string[]): Promise<unknown>;
    url?: string | (() => string | Promise<string>);
    title?: () => string | Promise<string>;
}

export interface BrowserElementCandidate {
    selector: string;
    index: number;
    locator: BrowserLocatorLike;
    visible: boolean;
}

export interface FindVisibleCandidateOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
    allowFirstCandidateFallback?: boolean;
}

export interface TextBaseline {
    selectors: readonly string[];
    texts: string[];
    count: number;
    textHash: string;
    capturedAt: string;
}

export interface StableTextOptions {
    timeoutMs: number;
    stableWindowMs?: number;
    pollIntervalMs?: number;
    minCount?: number;
}

export interface StableTextResult {
    ok: boolean;
    baseline: TextBaseline;
    latestText?: string;
    warnings: string[];
}

export interface BrowserDiagnosticsCaptureInput {
    page?: BrowserPageLike;
    selectors?: readonly string[];
    visibleSelectors?: readonly string[];
    maxTitleChars?: number;
    redactText?: (value: unknown, options?: { maxChars?: number }) => string;
}

export interface BrowserDiagnosticsSnapshot {
    url?: string;
    title?: string;
    selectorCounts: Record<string, number>;
    visibleCounts: Record<string, number>;
    warnings: string[];
}

declare const document: { querySelectorAll(selector: string): Iterable<TextNodeLike> };
declare function getComputedStyle(node: VisibleNodeLike): StyleLike | null;

export class BrowserCapabilityError extends Error {
    readonly capabilityId: string;
    readonly stage: string;
    readonly mutationAllowed: boolean;

    constructor(message: string, input: { capabilityId: string; stage: string; mutationAllowed?: boolean }) {
        super(message);
        this.name = 'BrowserCapabilityError';
        this.capabilityId = input.capabilityId;
        this.stage = input.stage;
        this.mutationAllowed = input.mutationAllowed === true;
    }
}

export class ActionTranscript {
    readonly warnings: string[] = [];
    readonly usedFallbacks: string[] = [];

    warn(message: string): void {
        this.warnings.push(message);
    }

    fallback(name: string): void {
        this.usedFallbacks.push(name);
    }

    toJSON(): { warnings: string[]; usedFallbacks: string[] } {
        return {
            warnings: [...this.warnings],
            usedFallbacks: [...this.usedFallbacks],
        };
    }
}

export async function findVisibleCandidate(
    page: BrowserPageLike,
    selectors: readonly string[],
    options: FindVisibleCandidateOptions = {},
): Promise<BrowserElementCandidate | null> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
    const deadline = Date.now() + timeoutMs;
    let firstCandidate: BrowserElementCandidate | null = null;

    do {
        for (const selector of selectors) {
            const baseLocator = page.locator(selector);
            const count = await baseLocator.count?.().catch(() => 0) ?? 0;
            for (let index = 0; index < count; index += 1) {
                const locator = typeof baseLocator.nth === 'function'
                    ? baseLocator.nth(index)
                    : baseLocator.first?.() ?? baseLocator;
                const visible = await isLocatorVisible(locator);
                const candidate = { selector, index, locator, visible };
                firstCandidate ??= candidate;
                if (visible) return candidate;
            }
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout?.(pollIntervalMs);
    } while (timeoutMs > 0);

    return options.allowFirstCandidateFallback ? firstCandidate : null;
}

export async function isLocatorVisible(locator: BrowserLocatorLike): Promise<boolean> {
    const waited = await locator.waitFor?.({ state: 'visible', timeout: 500 }).then(() => true).catch(() => false);
    if (waited) return true;
    const box = await locator.boundingBox?.().catch(() => null);
    if (box && box.width > 0 && box.height > 0) return true;
    return Boolean(await locator.evaluate?.((node: VisibleNodeLike) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
        return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
    }).catch(() => false));
}

export async function captureTextBaseline(page: BrowserPageLike, selectors: readonly string[]): Promise<TextBaseline> {
    const texts = await readTexts(page, selectors);
    return {
        selectors: [...selectors],
        texts,
        count: texts.length,
        textHash: hashTexts(texts),
        capturedAt: new Date().toISOString(),
    };
}

export async function waitForStableTextAfterBaseline(
    page: BrowserPageLike,
    selectors: readonly string[],
    baseline: TextBaseline,
    options: StableTextOptions,
): Promise<StableTextResult> {
    const timeoutMs = Math.max(1, options.timeoutMs);
    const stableWindowMs = Math.max(100, options.stableWindowMs ?? 1000);
    const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
    const minCount = Math.max(baseline.count + 1, options.minCount ?? 0);
    const deadline = Date.now() + timeoutMs;
    const warnings: string[] = [];
    let stableText: string | undefined;
    let stableSince: number | null = null;

    while (Date.now() < deadline) {
        const texts = await readTexts(page, selectors);
        const latestText = texts.slice(baseline.count).filter(Boolean).at(-1);
        if (texts.length >= minCount && latestText) {
            if (latestText === stableText) {
                if (stableSince !== null && Date.now() - stableSince >= stableWindowMs) {
                    return { ok: true, baseline, latestText, warnings };
                }
            } else {
                stableText = latestText;
                stableSince = Date.now();
            }
        } else {
            stableText = undefined;
            stableSince = null;
        }
        await page.waitForTimeout?.(pollIntervalMs);
    }
    warnings.push('stable-text-timeout');
    return stripUndefined({ ok: false, baseline, latestText: stableText, warnings });
}

export async function captureBrowserDiagnostics(input: BrowserDiagnosticsCaptureInput = {}): Promise<BrowserDiagnosticsSnapshot> {
    const page = input.page;
    const redact = input.redactText || ((value: unknown) => String(value ?? ''));
    const out: BrowserDiagnosticsSnapshot = {
        selectorCounts: {},
        visibleCounts: {},
        warnings: [],
    };
    if (!page) {
        out.warnings.push('no-page');
        return out;
    }
    try {
        const urlValue = typeof page.url === 'function' ? await page.url() : page.url;
        out.url = String(urlValue ?? '');
    } catch (e) {
        out.warnings.push(`url:${(e as Error).message}`);
    }
    try {
        out.title = redact(await page.title?.(), { maxChars: input.maxTitleChars ?? 256 });
    } catch (e) {
        out.warnings.push(`title:${(e as Error).message}`);
    }
    for (const selector of input.selectors || []) {
        out.selectorCounts[selector] = await countSelector(page, selector);
    }
    for (const selector of input.visibleSelectors || []) {
        out.visibleCounts[selector] = await countVisibleSelector(page, selector);
    }
    return out;
}

async function readTexts(page: BrowserPageLike, selectors: readonly string[]): Promise<string[]> {
    const evaluated = await page.evaluate?.((innerSelectors: readonly string[]) => {
        for (const selector of innerSelectors) {
            const texts = Array.from(document.querySelectorAll(selector))
                .map((el: TextNodeLike) => String(el.innerText || el.textContent || '').trim())
                .filter(Boolean);
            if (texts.length) return texts;
        }
        return [];
    }, selectors).catch(() => []);
    if (Array.isArray(evaluated) && evaluated.length > 0) return evaluated.map(String);

    for (const selector of selectors) {
        const locators = await page.locator(selector).all?.().catch(() => []) ?? [];
        const texts: string[] = [];
        for (const locator of locators) {
            const text = String(await locator.innerText?.().catch(() => '') || '').trim();
            if (text) texts.push(text);
        }
        if (texts.length) return texts;
    }
    return [];
}

async function countSelector(page: BrowserPageLike, selector: string): Promise<number> {
    try {
        return await page.locator(selector).count?.() ?? 0;
    } catch {
        return 0;
    }
}

async function countVisibleSelector(page: BrowserPageLike, selector: string): Promise<number> {
    try {
        const locators = await page.locator(selector).all?.() ?? [];
        let total = 0;
        for (const locator of locators) {
            if (await isLocatorVisible(locator)) total += 1;
        }
        return total;
    } catch {
        return 0;
    }
}

function hashTexts(texts: readonly string[]): string {
    let hash = 2166136261;
    for (const text of texts) {
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
    }
    return (hash >>> 0).toString(16);
}
