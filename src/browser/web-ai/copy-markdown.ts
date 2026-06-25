import type { Page } from 'playwright-core';

type BrowserEventInitLike = { bubbles?: boolean; cancelable?: boolean; view?: unknown };
type BrowserEventConstructor = new (type: string, eventInitDict?: BrowserEventInitLike) => unknown;
type BrowserCopyButtonLike = {
    offsetParent?: unknown;
    getClientRects(): { length: number };
    dispatchEvent(event: unknown): boolean;
    click?: () => void;
};
type BrowserTurnLike = {
    querySelectorAll(selector: string): Iterable<BrowserCopyButtonLike>;
};
type BrowserDocumentLike = {
    querySelectorAll(selector: string): Iterable<BrowserTurnLike>;
};
type BrowserClipboardItemLike = {
    types?: string[];
    getType(type: string): Promise<{ text(): Promise<string> }>;
};
type BrowserClipboardLike = {
    writeText?: (text: string) => Promise<void>;
    write?: (items: BrowserClipboardItemLike[]) => Promise<void>;
};
type CopyMarkdownEvaluateInput = {
    selectorSet: CopyMarkdownSelectorSet;
    timeoutMs: number;
    stableTicks: number;
};
type CopyMarkdownEvaluateResult =
    | { ok: true; text: string }
    | { ok: false; status: CopyMarkdownResult['status']; error?: string };

declare const document: BrowserDocumentLike;
declare const navigator: { clipboard?: BrowserClipboardLike };
declare const window: unknown;
declare const PointerEvent: BrowserEventConstructor;
declare const MouseEvent: BrowserEventConstructor;

export interface CopyMarkdownSelectorSet {
    turnSelectors: string[];
    copyButtonSelectors: string[];
}

export interface CopyMarkdownResult {
    ok: boolean;
    text?: string;
    status?: 'missing-turn' | 'missing-button' | 'missing-clipboard' | 'timeout' | 'empty' | 'exception';
    error?: string;
}

export interface CopyMarkdownOptions {
    timeoutMs?: number;
    stableTicks?: number;
    copyTarget?: { selector?: string | null } | null;
}

export const CHATGPT_COPY_SELECTORS: CopyMarkdownSelectorSet = {
    turnSelectors: [
        '[data-message-author-role="assistant"]',
        '[data-turn="assistant"]',
        'article[data-testid^="conversation-turn"]:has([data-message-author-role="assistant"])',
    ],
    copyButtonSelectors: [
        'button[data-testid="copy-turn-action-button"]',
        'button[aria-label*="Copy" i]',
    ],
};

export const GEMINI_COPY_SELECTORS: CopyMarkdownSelectorSet = {
    turnSelectors: ['model-response', '[data-response-index]'],
    copyButtonSelectors: [
        'button[data-test-id="copy-button"]',
        'button[aria-label="Copy"]',
        'button[aria-label*="Copy" i]',
    ],
};

export const GROK_COPY_SELECTORS: CopyMarkdownSelectorSet = {
    turnSelectors: ['[data-testid="assistant-message"]', '[id^="response-"]:has([data-testid="assistant-message"])'],
    copyButtonSelectors: [
        'button[aria-label="Copy"]',
        'button[aria-label*="Copy" i]',
    ],
};

export async function captureCopiedResponseText(
    page: Page,
    selectors: CopyMarkdownSelectorSet,
    options: CopyMarkdownOptions = {},
): Promise<CopyMarkdownResult> {
    const selectorSet = copySelectorsWithTarget(selectors, options.copyTarget);
    try {
        const result = await page.evaluate<CopyMarkdownEvaluateResult, CopyMarkdownEvaluateInput>(
            async ({ selectorSet, timeoutMs, stableTicks }: CopyMarkdownEvaluateInput): Promise<CopyMarkdownEvaluateResult> => {
                const doc = document;
                const turns = selectorSet.turnSelectors
                    .flatMap((selector: string) => Array.from(doc.querySelectorAll(selector)))
                    .filter((node: BrowserTurnLike, index: number, arr: BrowserTurnLike[]) => arr.indexOf(node) === index);
                const turn = turns.at(-1);
                if (!turn) return { ok: false, status: 'missing-turn' };

                let button: BrowserCopyButtonLike | null = null;
                for (const selector of selectorSet.copyButtonSelectors) {
                    const scoped = Array.from(turn.querySelectorAll(selector));
                    button = scoped.find(candidate => candidate.offsetParent !== null || candidate.getClientRects().length > 0) || scoped.at(-1) || null;
                    if (button) break;
                }
                if (!button) return { ok: false, status: 'missing-button' };

                const clipboard = navigator.clipboard;
                if (!clipboard) return { ok: false, status: 'missing-clipboard' };

                const originalWriteText = clipboard.writeText?.bind(clipboard);
                const originalWrite = clipboard.write?.bind(clipboard);
                // 104.17: suppress copy-induced scroll-jump (clicking the copy button can
                // scrollIntoView/focus the turn). Saved here, patched around the copy, restored in finally.
                const origScrollIntoView = Element.prototype.scrollIntoView;
                const origFocus = HTMLElement.prototype.focus;
                let intercepted = '';
                let last = '';
                let ticks = 0;

                const store = (value: unknown) => {
                    const text = String(value ?? '');
                    if (text.trim()) intercepted = text;
                };

                try {
                    if (originalWriteText) {
                        Object.defineProperty(clipboard, 'writeText', {
                            configurable: true,
                            value: async (text: string) => {
                                store(text);
                            },
                        });
                    }
                    if (originalWrite) {
                        Object.defineProperty(clipboard, 'write', {
                            configurable: true,
                            value: async (items: BrowserClipboardItemLike[]) => {
                                for (const item of items || []) {
                                    const types = item.types || [];
                                    const type = types.includes('text/plain') ? 'text/plain' : types.find((t: string) => t.startsWith('text/'));
                                    if (!type) continue;
                                    const blob = await item.getType(type);
                                    store(await blob.text());
                                    break;
                                }
                            },
                        });
                    }

                    Element.prototype.scrollIntoView = function () {};
                    HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
                        return origFocus.call(this, Object.assign({}, opts, { preventScroll: true }));
                    };

                    const clickInit = { bubbles: true, cancelable: true, view: window };
                    button.dispatchEvent(new PointerEvent('pointerdown', clickInit));
                    button.dispatchEvent(new MouseEvent('mousedown', clickInit));
                    button.dispatchEvent(new PointerEvent('pointerup', clickInit));
                    button.dispatchEvent(new MouseEvent('mouseup', clickInit));
                    button.dispatchEvent(new MouseEvent('click', clickInit));
                    button.click?.();

                    const deadline = Date.now() + timeoutMs;
                    while (Date.now() < deadline) {
                        if (intercepted.trim()) {
                            if (intercepted === last) ticks += 1;
                            else {
                                last = intercepted;
                                ticks = 1;
                            }
                            if (ticks >= stableTicks) return { ok: true, text: intercepted };
                        }
                        await new Promise(resolve => setTimeout(resolve, 80));
                    }
                    return intercepted.trim()
                        ? { ok: true, text: intercepted }
                        : { ok: false, status: 'timeout' };
                } finally {
                    Element.prototype.scrollIntoView = origScrollIntoView;
                    HTMLElement.prototype.focus = origFocus;
                    if (originalWriteText) {
                        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: originalWriteText });
                    }
                    if (originalWrite) {
                        Object.defineProperty(clipboard, 'write', { configurable: true, value: originalWrite });
                    }
                }
            },
            {
                selectorSet,
                timeoutMs: Math.max(250, options.timeoutMs ?? 1500),
                stableTicks: Math.max(1, options.stableTicks ?? 3),
            },
        );
        if (result?.ok === true && typeof result.text === 'string' && result.text.trim()) {
            return { ok: true, text: result.text };
        }
        const failed = result?.ok === false ? result : null;
        return {
            ok: false,
            status: failed?.status || 'empty',
            ...(failed?.error ? { error: String(failed.error) } : {}),
        };
    } catch (e) {
        return { ok: false, status: 'exception', error: (e as Error).message };
    }
}

function copySelectorsWithTarget(
    selectors: CopyMarkdownSelectorSet,
    copyTarget: { selector?: string | null } | null = null,
): CopyMarkdownSelectorSet {
    if (!copyTarget?.selector) return selectors;
    const existingSelectors = selectors.copyButtonSelectors || [];
    if (existingSelectors.includes(copyTarget.selector)) {
        return {
            ...selectors,
            copyButtonSelectors: [...new Set(existingSelectors)],
        };
    }
    return {
        ...selectors,
        copyButtonSelectors: [
            copyTarget.selector,
            ...existingSelectors,
        ],
    };
}

export function preferCopiedText(domText: string, copied: CopyMarkdownResult): string | undefined {
    const copiedText = String(copied.text || '').trim();
    if (!copied.ok || !copiedText) return undefined;
    const normalizedDom = String(domText || '').trim();
    if (!normalizedDom) return copiedText;
    const minimumReasonableLength = Math.floor(normalizedDom.length * 0.7);
    return copiedText.length >= minimumReasonableLength ? copiedText : undefined;
}
