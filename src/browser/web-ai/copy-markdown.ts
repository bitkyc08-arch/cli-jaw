declare const document: any;
declare const navigator: any;
declare const window: any;
declare const PointerEvent: any;
declare const MouseEvent: any;

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

export async function captureCopiedResponseText(
    page: any,
    selectors: CopyMarkdownSelectorSet,
    options: CopyMarkdownOptions = {},
): Promise<CopyMarkdownResult> {
    try {
        const result = await page.evaluate?.(
            async ({ selectorSet, timeoutMs, stableTicks }: any) => {
                const doc = document;
                const turns = selectorSet.turnSelectors
                    .flatMap((selector: string) => Array.from(doc.querySelectorAll(selector)))
                    .filter((node: any, index: number, arr: any[]) => arr.indexOf(node) === index);
                const turn = turns.at(-1);
                if (!turn) return { ok: false, status: 'missing-turn' };

                let button: any = null;
                for (const selector of selectorSet.copyButtonSelectors) {
                    const scoped = Array.from(turn.querySelectorAll(selector)) as any[];
                    button = scoped.find(candidate => candidate.offsetParent !== null || candidate.getClientRects().length > 0) || scoped.at(-1) || null;
                    if (button) break;
                }
                if (!button) return { ok: false, status: 'missing-button' };

                const clipboard = navigator.clipboard as {
                    writeText?: (text: string) => Promise<void>;
                    write?: (items: any[]) => Promise<void>;
                };
                if (!clipboard) return { ok: false, status: 'missing-clipboard' };

                const originalWriteText = clipboard.writeText?.bind(clipboard);
                const originalWrite = clipboard.write?.bind(clipboard);
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
                            value: async (items: any[]) => {
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
                    if (originalWriteText) {
                        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: originalWriteText });
                    }
                    if (originalWrite) {
                        Object.defineProperty(clipboard, 'write', { configurable: true, value: originalWrite });
                    }
                }
            },
            {
                selectorSet: selectors,
                timeoutMs: Math.max(250, options.timeoutMs ?? 1500),
                stableTicks: Math.max(1, options.stableTicks ?? 3),
            },
        );
        if (result?.ok && typeof result.text === 'string' && result.text.trim()) {
            return { ok: true, text: result.text };
        }
        return {
            ok: false,
            status: result?.status || 'empty',
            ...(result?.error ? { error: String(result.error) } : {}),
        };
    } catch (e) {
        return { ok: false, status: 'exception', error: (e as Error).message };
    }
}

export function preferCopiedText(domText: string, copied: CopyMarkdownResult): string | undefined {
    const copiedText = String(copied.text || '').trim();
    if (!copied.ok || !copiedText) return undefined;
    const normalizedDom = String(domText || '').trim();
    if (!normalizedDom) return copiedText;
    const minimumReasonableLength = Math.floor(normalizedDom.length * 0.7);
    return copiedText.length >= minimumReasonableLength ? copiedText : undefined;
}
