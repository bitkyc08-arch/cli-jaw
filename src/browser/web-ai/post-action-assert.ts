import { wrapError } from './errors.js';
import type { TraceContext } from './action-trace.js';
import type { ResolvedActionTarget } from './action-cache.js';
import { stripUndefined } from '../../core/strip-undefined.js';

export interface PostActionAssertionOptions {
    expectedValue?: string;
    expectElementVisible?: string;
    expectUrlChange?: boolean;
    timeoutMs?: number;
}

export interface PostActionAssertionResult {
    ok: boolean;
    reason?: string;
    expected?: string;
    actual?: string;
    beforeUrl?: string;
    afterUrl?: string;
}

export interface LocatorLike {
    click(): Promise<void>;
    fill?(value: string): Promise<void>;
    inputValue?(): Promise<string>;
    evaluate<T>(fn: (el: LocatorNodeLike) => T | Promise<T>): Promise<T>;
    isVisible?(): Promise<boolean>;
}

interface LocatorNodeLike {
    textContent?: string | null;
    value?: string;
}

interface FocusDocumentLike {
    querySelector(value: string): { contains(value: unknown): boolean } | null;
    activeElement: unknown;
}

type FocusGlobalLike = typeof globalThis & {
    document: FocusDocumentLike;
};

export interface PageLike {
    url(): string;
    locator(selector: string): LocatorLike;
    waitForURL?(predicate: (url: URL | string) => boolean, options?: { timeout?: number }): Promise<void>;
    evaluate?<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
    keyboard: {
        press(key: string): Promise<void>;
        insertText(text: string): Promise<void>;
    };
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

export async function assertPostAction(
    page: PageLike,
    action: 'fill' | 'click' | string,
    target: ResolvedActionTarget,
    options: PostActionAssertionOptions = {},
): Promise<PostActionAssertionResult> {
    try {
        switch (action) {
            case 'fill': {
                if (!target.selector) return { ok: false, reason: 'missing-selector' };
                const locator = page.locator(target.selector);
                const inputValue = typeof locator.inputValue === 'function'
                    ? await locator.inputValue().catch(() => null)
                    : null;
                const value = inputValue ?? await locator.evaluate((el) => el.textContent || el.value || '').catch(() => '');
                const expected = options.expectedValue;
                if (expected && value !== expected) return { ok: false, reason: 'value-mismatch', expected, actual: value };
                return { ok: true };
            }
            case 'click': {
                if (options.expectElementVisible) {
                    const visible = await page.locator(options.expectElementVisible).isVisible?.().catch(() => false);
                    if (!visible) return { ok: false, reason: 'expected-element-not-visible' };
                }
                return { ok: true };
            }
            default:
                return { ok: true };
        }
    } catch (err) {
        throw wrapError(err, {
            errorCode: 'internal.unhandled',
            stage: 'post-action-assert',
            retryHint: 'report',
        });
    }
}

export async function clickWithPostAssert(
    page: PageLike,
    locator: LocatorLike,
    resolvedTarget: ResolvedActionTarget,
    traceCtx: TraceContext | null | undefined,
    options: PostActionAssertionOptions = {},
): Promise<PostActionAssertionResult> {
    const beforeUrl = page.url();
    try {
        await locator.click();
    } catch (err) {
        traceCtx?.record(stripUndefined({ action: 'click', target: scrubTargetForTrace(resolvedTarget), status: 'error', errorCode: (err as { name?: string }).name }));
        throw wrapError(err, { stage: 'post-action-click', retryHint: 're-snapshot' });
    }

    if (options.expectUrlChange && page.waitForURL) {
        try {
            await page.waitForURL((url) => String(url) !== beforeUrl, { timeout: options.timeoutMs ?? 3000 });
        } catch {
            const afterUrl = page.url();
            if (afterUrl === beforeUrl) {
                const failure = { ok: false, reason: 'url-unchanged', beforeUrl, afterUrl };
                traceCtx?.record({ action: 'click', target: scrubTargetForTrace(resolvedTarget), status: 'false-heal', error: failure });
                return failure;
            }
        }
    }

    const assertion = await assertPostAction(page, 'click', resolvedTarget, options);
    if (!assertion.ok) {
        traceCtx?.record({ action: 'click', target: scrubTargetForTrace(resolvedTarget), status: 'false-heal', error: assertion });
        return assertion;
    }
    traceCtx?.record({ action: 'click', target: scrubTargetForTrace(resolvedTarget), status: 'ok' });
    return { ok: true };
}

export async function fillWithPostAssert(
    page: PageLike,
    locator: LocatorLike,
    resolvedTarget: ResolvedActionTarget,
    value: string,
    traceCtx: TraceContext | null | undefined,
    options: PostActionAssertionOptions = {},
): Promise<PostActionAssertionResult> {
    try {
        if (typeof locator.fill !== 'function') throw new Error('locator.fill is unavailable');
        await locator.fill(value);
    } catch (fillErr) {
        const role = resolvedTarget.role || '';
        const isContentEditable = role === 'textbox' || resolvedTarget["contentEditable"] === true;
        if (!isContentEditable) {
            traceCtx?.record(stripUndefined({ action: 'fill', target: scrubTargetForTrace(resolvedTarget), status: 'error', errorCode: (fillErr as { name?: string }).name }));
            throw wrapError(fillErr, { stage: 'post-action-fill', retryHint: 're-snapshot' });
        }
        try {
            await locator.click();
            const focused = await page.evaluate?.((selector) => {
                const doc = (globalThis as FocusGlobalLike).document;
                const target = selector ? doc.querySelector(selector) : null;
                return !!target && (doc.activeElement === target || target.contains(doc.activeElement));
            }, resolvedTarget.selector || null).catch(() => false);
            if (!focused) {
                traceCtx?.record({ action: 'fill', target: scrubTargetForTrace(resolvedTarget), status: 'error', errorCode: 'focus-mismatch' });
                throw fillErr;
            }
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.press(`${mod}+a`);
            await page.keyboard.insertText(value);
        } catch (kbErr) {
                traceCtx?.record(stripUndefined({ action: 'fill', target: scrubTargetForTrace(resolvedTarget), status: 'error', errorCode: (kbErr as { name?: string }).name }));
            throw wrapError(kbErr, { stage: 'post-action-fill-keyboard', retryHint: 're-snapshot' });
        }
    }

    const assertion = await assertPostAction(page, 'fill', resolvedTarget, { ...options, expectedValue: value });
    if (!assertion.ok) {
        traceCtx?.record({ action: 'fill', target: scrubTargetForTrace(resolvedTarget), status: 'false-heal', error: assertion });
        return assertion;
    }
    traceCtx?.record({ action: 'fill', target: scrubTargetForTrace(resolvedTarget), status: 'ok' });
    return { ok: true };
}
