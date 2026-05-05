import { clickWithPostAssert, fillWithPostAssert } from './post-action-assert.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import type { TraceContext } from './action-trace.js';
import type { ResolvedActionTarget } from './action-cache.js';
import type { LocatorLike as PostActionLocatorLike, PageLike as PostActionPageLike } from './post-action-assert.js';

type BoxLike = { width: number; height: number };
type StyleLike = { display?: string; visibility?: string; opacity?: string };
type VisibleNodeLike = { getBoundingClientRect?: () => BoxLike };
type TextNodeLike = { innerText?: string; textContent?: string };
type BrowserGlobal = typeof globalThis & {
    getComputedStyle?: (node: VisibleNodeLike) => StyleLike | null;
};

declare const document: { querySelectorAll(selector: string): Iterable<TextNodeLike> };

export class BrowserCapabilityError extends Error {
    capabilityId: string;
    stage: string;
    mutationAllowed: boolean;

    constructor(message: string, input: { capabilityId: string; stage: string; mutationAllowed?: boolean }) {
        super(message);
        this.name = 'BrowserCapabilityError';
        this.capabilityId = input.capabilityId;
        this.stage = input.stage;
        this.mutationAllowed = input.mutationAllowed === true;
    }
}

export class ActionTranscript {
    warnings: string[] = [];
    usedFallbacks: string[] = [];

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

export interface FindVisibleCandidateOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
    allowFirstCandidateFallback?: boolean;
}

export interface VisibleCandidate {
    selector: string;
    index: number;
    locator: LocatorLike;
    visible: boolean;
}

export interface LocatorLike {
    count?(): Promise<number>;
    nth?(index: number): LocatorLike;
    first?(): LocatorLike;
    all?(): Promise<LocatorLike[]>;
    waitFor?(options: { state: 'visible'; timeout: number }): Promise<unknown>;
    boundingBox?(): Promise<BoxLike | null>;
    evaluate?<T>(fn: (node: VisibleNodeLike) => T | Promise<T>): Promise<T>;
    innerText?(): Promise<string>;
}

export interface PageLike {
    locator(selector: string): LocatorLike;
    waitForTimeout?(ms: number): Promise<void>;
    evaluate?(fn: (innerSelectors: string[]) => string[], arg: string[]): Promise<unknown>;
}

export async function findVisibleCandidate(
    page: PageLike,
    selectors: string[],
    options: FindVisibleCandidateOptions = {},
): Promise<VisibleCandidate | null> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
    const deadline = Date.now() + timeoutMs;
    let firstCandidate: VisibleCandidate | null = null;

    do {
        for (const selector of selectors) {
            const baseLocator = page.locator(selector);
            const count = await baseLocator.count?.().catch(() => 0) ?? 0;
            for (let index = 0; index < count; index += 1) {
                const locator = typeof baseLocator.nth === 'function'
                    ? baseLocator.nth(index)
                    : baseLocator.first?.() ?? baseLocator;
                const visible = await isLocatorVisible(locator);
                const candidate: VisibleCandidate = { selector, index, locator, visible };
                firstCandidate ??= candidate;
                if (visible) return candidate;
            }
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout?.(pollIntervalMs);
    } while (timeoutMs > 0);

    return options.allowFirstCandidateFallback ? firstCandidate : null;
}

export interface TextBaseline {
    selectors: string[];
    texts: string[];
    count: number;
    textHash: string;
    capturedAt: string;
}

export async function captureTextBaseline(page: PageLike, selectors: string[]): Promise<TextBaseline> {
    const texts = await readTexts(page, selectors);
    return {
        selectors: [...selectors],
        texts,
        count: texts.length,
        textHash: hashTexts(texts),
        capturedAt: new Date().toISOString(),
    };
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

export async function waitForStableTextAfterBaseline(
    page: PageLike,
    selectors: string[],
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

export async function isLocatorVisible(locator: LocatorLike): Promise<boolean> {
    const waited = await locator.waitFor?.({ state: 'visible', timeout: 500 }).then(() => true).catch(() => false);
    if (waited) return true;
    const box = await locator.boundingBox?.().catch(() => null);
    if (box && box.width > 0 && box.height > 0) return true;
    return Boolean(await locator.evaluate?.((node: VisibleNodeLike) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = (globalThis as BrowserGlobal).getComputedStyle?.(node);
        return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
    }).catch(() => false));
}

async function readTexts(page: PageLike, selectors: string[]): Promise<string[]> {
    const evaluated = await page.evaluate?.((innerSelectors: string[]) => {
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

function hashTexts(texts: string[]): string {
    let hash = 2166136261;
    for (const text of texts) {
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
    }
    return (hash >>> 0).toString(16);
}

export async function clickResolvedTarget(
    page: PostActionPageLike,
    locator: PostActionLocatorLike,
    resolvedTarget: ResolvedActionTarget,
    traceCtx: TraceContext | undefined,
): Promise<import('./post-action-assert.js').PostActionAssertionResult> {
    return clickWithPostAssert(page, locator, resolvedTarget, traceCtx);
}

export async function fillResolvedTarget(
    page: PostActionPageLike,
    locator: PostActionLocatorLike,
    resolvedTarget: ResolvedActionTarget,
    value: string,
    traceCtx: TraceContext | undefined,
): Promise<import('./post-action-assert.js').PostActionAssertionResult> {
    return fillWithPostAssert(page, locator, resolvedTarget, value, traceCtx);
}

export function scrubTargetForTrace(target: ResolvedActionTarget | null | undefined): Record<string, unknown> | null {
    if (!target) return null;
    return {
        resolution: target["resolution"] || null,
        source: target["source"] || null,
        ref: target["ref"] || null,
        selector: target.selector || null,
        role: target.role || null,
    };
}
