import type { PromptCommitBaseline, PromptCommitResult, PromptSubmitResult, SendTarget, VendorEditorAdapterOptions } from './vendor-editor-contract.js';
import { findVisibleCandidate, type BrowserLocatorLike } from '../primitives.js';
import type { Page } from 'playwright-core';

type BoxLike = { width: number; height: number };
type StyleLike = { display?: string; visibility?: string; opacity?: string; pointerEvents?: string };
type EventLike = unknown;
type EventInitLike = {
    bubbles?: boolean;
    cancelable?: boolean;
    view?: WindowLike;
    pointerId?: number;
    pointerType?: string;
    inputType?: string;
    data?: string;
};
type BrowserNodeLike = {
    value?: string;
    textContent?: string | null;
    innerText?: string;
    dispatchEvent?(event: EventLike): boolean;
    focus?(): void;
    getBoundingClientRect?(): BoxLike;
    closest?(selector: string): BrowserNodeLike | null;
    parentElement?: BrowserNodeLike | null;
    querySelectorAll?(selector: string): Iterable<BrowserNodeLike>;
    hasAttribute?(name: string): boolean;
    getAttribute?(name: string): string | null;
    ownerDocument?: {
        getSelection?(): {
            removeAllRanges(): void;
            addRange(range: unknown): void;
        } | null;
        createRange?(): {
            selectNodeContents(node: BrowserNodeLike): void;
            collapse(toStart?: boolean): void;
        };
    };
};
type DocumentLike = BrowserNodeLike & {
    querySelector(selector: string): BrowserNodeLike | null;
    querySelectorAll(selector: string): Iterable<BrowserNodeLike>;
};
type WindowLike = {
    getComputedStyle?(node: BrowserNodeLike): StyleLike | null;
};
type ComposerLocator = BrowserLocatorLike & {
    click(): Promise<void>;
    evaluate<T, A = unknown>(fn: (node: BrowserNodeLike, arg: A) => T | Promise<T>, arg?: A): Promise<T>;
    inputValue?(): Promise<string>;
    innerText?(): Promise<string>;
};

declare const document: DocumentLike;
declare const window: WindowLike;
declare const PointerEvent: new (type: string, init?: EventInitLike) => EventLike;
declare const MouseEvent: new (type: string, init?: EventInitLike) => EventLike;
declare const InputEvent: new (type: string, init?: EventInitLike) => EventLike;
declare const Event: new (type: string, init?: EventInitLike) => EventLike;

export const INPUT_SELECTORS = [
    'textarea[data-id="prompt-textarea"]',
    'textarea[placeholder*="Send a message"]',
    'textarea[aria-label="Message ChatGPT"]',
    'main textarea:not([disabled])',
    'form textarea:not([disabled])',
    // 105.8: restore agbrowse's bare-textarea fallback (cli-jaw had narrowed to main/form-scoped only,
    // missing layouts where the composer textarea is neither inside <main> nor a <form>).
    'textarea:not([disabled])',
    'textarea[name="prompt-textarea"]',
    '#prompt-textarea',
    '.ProseMirror',
    '[contenteditable="true"][data-virtualkeyboard="true"]',
    '[contenteditable="true"]',
] as const;

export const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid*="composer-send"]',
    'button[type="submit"][data-testid*="send"]',
    'button[aria-label*="Send prompt" i]',
    'button[aria-label*="Send message" i]',
    // 105.8: restore agbrowse's generic Send fallbacks (precision-first ordering kept — these run last)
    // so a relabeled / form-submit Send button is still found when the specific testids/labels miss.
    'form button[type="submit"]',
    'button[aria-label*="Send" i]',
] as const;

export const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const ASSISTANT_ROLE_SELECTOR = '[data-message-author-role="assistant"], [data-turn="assistant"]';
export const CONVERSATION_TURN_SELECTOR = [
    'article[data-testid^="conversation-turn"]',
    'div[data-testid^="conversation-turn"]',
    'section[data-testid^="conversation-turn"]',
    'article[data-message-author-role]',
    'div[data-message-author-role]',
    'section[data-message-author-role]',
    'article[data-turn]',
    'div[data-turn]',
    'section[data-turn]',
].join(', ');

const INSERT_SETTLE_MS = 500;
const DEFAULT_COMMIT_TIMEOUT_MS = 60_000;

type ComposerState = {
    editorText: string;
    fallbackValue: string;
    activeValue: string;
};

type ComposerCandidate = {
    selector: string;
    locator: ComposerLocator;
};

export async function findComposerCandidate(page: Page, options: VendorEditorAdapterOptions = {}): Promise<ComposerCandidate> {
    // 104.12: a resolver-verified composer target short-circuits the selector scan.
    if (options.composerTarget?.selector) {
        return {
            selector: options.composerTarget.selector,
            locator: page.locator(options.composerTarget.selector).first() as unknown as ComposerLocator,
        };
    }
    const candidate = await findVisibleCandidate(page, INPUT_SELECTORS, { allowFirstCandidateFallback: true });
    if (candidate) return { selector: candidate.selector, locator: candidate.locator as ComposerLocator };
    throw new Error(`ChatGPT composer not found. Tried: ${INPUT_SELECTORS.join(', ')}`);
}

export async function insertPromptIntoComposer(page: Page, text: string, options: VendorEditorAdapterOptions = {}): Promise<void> {
    const candidate = await findComposerCandidate(page, options);
    await focusComposerLikeUser(candidate.locator);
    try {
        await insertTextLikeProvider(page, text, options);
    } catch {
        await writeComposerFallback(page, candidate.locator, text);
    }
    await page.waitForTimeout?.(INSERT_SETTLE_MS);
    const state = await readComposerState(page, candidate.locator);
    if (!hasInsertedText(state, text)) {
        await writeComposerFallback(page, candidate.locator, text);
        await page.waitForTimeout?.(INSERT_SETTLE_MS);
    }
    const verified = await readComposerState(page, candidate.locator);
    if (!hasInsertedText(verified, text)) {
        throw new Error('composer verification failed after prompt insertion');
    }
    if (text.length >= 50_000 && maxComposerLength(verified) > 0 && maxComposerLength(verified) < text.length - 2_000) {
        throw new Error('Prompt appears truncated in the composer');
    }
}

export async function submitPromptFromComposer(page: Page, options: VendorEditorAdapterOptions = {}): Promise<PromptSubmitResult> {
    // 104.12: a resolver-verified send target is tried first (with force-retry), then the scan, then Enter.
    if (options.sendTarget?.selector) {
        const clickedResolved = await clickResolvedSendButton(page, options.sendTarget);
        if (clickedResolved) {
            return { method: 'button', selector: options.sendTarget.selector, resolution: options.sendTarget.resolution ?? null };
        }
    }
    const clicked = await clickEnabledSendButton(page, options.sendButtonTimeoutMs);
    if (clicked) return { method: 'button' };
    await page.keyboard.press('Enter');
    return { method: 'enter' };
}

export async function verifyPromptCommitted(
    page: Page,
    prompt: string,
    options: PromptCommitBaseline & { timeoutMs?: number } = {},
): Promise<PromptCommitResult> {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_COMMIT_TIMEOUT_MS);
    const baselineTurns = Number.isFinite(Number(options.turnsCount)) ? Number(options.turnsCount) : -1;
    const deadline = Date.now() + timeoutMs;
    const normalizedPrompt = normalizePrompt(prompt);
    const promptPrefix = normalizedPrompt.slice(0, 120);

    while (Date.now() <= deadline) {
        const [turns, composerState, stopVisible, assistantVisible] = await Promise.all([
            readConversationTurns(page),
            readComposerState(page).catch(() => ({ editorText: '', fallbackValue: '', activeValue: '' })),
            locatorExists(page, STOP_BUTTON_SELECTOR),
            locatorExists(page, ASSISTANT_ROLE_SELECTOR),
        ]);
        const normalizedTurns = turns.map(normalizePrompt);
        const hasPrompt = normalizedTurns.some(turn => turn.includes(normalizedPrompt) || (promptPrefix.length > 30 && turn.includes(promptPrefix)));
        const hasNewTurn = baselineTurns < 0 ? turns.length > 0 : turns.length > baselineTurns;
        const composerCleared = !maxComposerLength(composerState);
        if (hasPrompt && hasNewTurn) return { turnsCount: turns.length };
        if (composerCleared && hasNewTurn && (stopVisible || assistantVisible)) return { turnsCount: turns.length };
        await page.waitForTimeout?.(100);
    }
    throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}

export async function countConversationTurns(page: Page): Promise<number> {
    return (await readConversationTurns(page)).length;
}

async function focusComposerLikeUser(locator: ComposerLocator): Promise<void> {
    await locator.click().catch(() => undefined);
    await locator.evaluate?.((node: BrowserNodeLike) => {
        const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const type of types) {
            const common = { bubbles: true, cancelable: true, view: window };
            const event = type.startsWith('pointer') && 'PointerEvent' in window
                ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
                : new MouseEvent(type, common);
            node.dispatchEvent?.(event);
        }
        if (typeof node.focus === 'function') node.focus();
        const selection = node.ownerDocument?.getSelection?.();
        if (selection && typeof node.ownerDocument?.createRange === 'function') {
            const range = node.ownerDocument.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }).catch(() => undefined);
}

export async function insertTextLikeProvider(page: Page, text: string, options: VendorEditorAdapterOptions = {}): Promise<void> {
    if (typeof options.insertText === 'function') {
        await options.insertText(text);
        return;
    }
    // 104.14: CDP Input.insertText handles large prompts the keyboard insertText path can choke on.
    if (typeof options.getCdpSession === 'function') {
        const cdp = await options.getCdpSession();
        if (cdp) {
            try {
                await cdp.send('Input.insertText', { text });
            } finally {
                await cdp.detach?.().catch(() => undefined);
            }
            return;
        }
    }
    await page.keyboard.insertText(text);
}

async function writeComposerFallback(page: Page, locator: ComposerLocator, text: string): Promise<void> {
    if (typeof page.evaluate === 'function') {
        const wrote = await page.evaluate(({ selectors, value }: { selectors: readonly string[]; value: string }) => {
            const write = (node: BrowserNodeLike | null): boolean => {
                if (!node) return false;
                if ('value' in node && typeof node.value !== 'undefined') {
                    node.value = value;
                    node.dispatchEvent?.(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
                    node.dispatchEvent?.(new Event('change', { bubbles: true }));
                    return true;
                }
                node.textContent = value;
                node.dispatchEvent?.(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
                return true;
            };
            let wroteAny = false;
            wroteAny = write(document.querySelector('textarea[name="prompt-textarea"]')) || wroteAny;
            wroteAny = write(document.querySelector('#prompt-textarea')) || wroteAny;
            for (const selector of selectors) {
                const node = document.querySelector(selector);
                wroteAny = write(node) || wroteAny;
            }
            return wroteAny;
        }, { selectors: INPUT_SELECTORS, value: text }).catch(() => false);
        if (wrote) return;
    }
    await locator.evaluate((node: BrowserNodeLike, value: string) => {
        if ('value' in node && typeof node.value !== 'undefined') {
            node.value = value;
            node.dispatchEvent?.(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
            node.dispatchEvent?.(new Event('change', { bubbles: true }));
            return;
        }
        node.textContent = value;
        node.dispatchEvent?.(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
    }, text);
}

async function readComposerState(page: Page, fallbackLocator?: ComposerLocator): Promise<ComposerState> {
    if (typeof page.evaluate === 'function') {
        const value = await page.evaluate((selectors: readonly string[]) => {
            const read = (node: BrowserNodeLike | null): string => {
                if (!node) return '';
                if (typeof node.value === 'string') return node.value || '';
                return node.innerText || node.textContent || '';
            };
            const isVisible = (node: BrowserNodeLike | null): boolean => {
                if (!node || typeof node.getBoundingClientRect !== 'function') return false;
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const nodes = selectors.map(selector => document.querySelector(selector)).filter(Boolean);
            const active = nodes.find(isVisible) || nodes[0] || null;
            return {
                editorText: read(document.querySelector('#prompt-textarea')),
                fallbackValue: read(document.querySelector('textarea[name="prompt-textarea"]')),
                activeValue: read(active),
            };
        }, INPUT_SELECTORS).catch(() => null);
        if (value) return value;
    }
    if (!fallbackLocator) {
        const candidate = await findComposerCandidate(page);
        fallbackLocator = candidate.locator;
    }
    const actual = await fallbackLocator.inputValue?.().catch(async () => fallbackLocator.innerText?.()).catch(() => '');
    return { editorText: String(actual || ''), fallbackValue: '', activeValue: String(actual || '') };
}

// 104.12: click a resolver-verified send button, with a force-retry before giving up.
async function clickResolvedSendButton(page: Page, target: SendTarget): Promise<boolean> {
    const button = page.locator(target.selector).first();
    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    if (!visible || !enabled) return false;
    try {
        await button.click({ timeout: 5_000 });
        return true;
    } catch {
        try {
            await button.click({ timeout: 2_000, force: true });
            return true;
        } catch {
            return false;
        }
    }
}

async function clickEnabledSendButton(page: Page, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await page.evaluate(({ inputSelectors, sendSelectors }: { inputSelectors: readonly string[]; sendSelectors: readonly string[] }) => {
            const dispatchClickSequence = (target: BrowserNodeLike | null): boolean => {
                if (!target || typeof target.dispatchEvent !== 'function') return false;
                for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                    const common = { bubbles: true, cancelable: true, view: window };
                    const event = type.startsWith('pointer') && 'PointerEvent' in window
                        ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
                        : new MouseEvent(type, common);
                    target.dispatchEvent(event);
                }
                return true;
            };
            const isVisible = (node: BrowserNodeLike | null): boolean => {
                if (!node || typeof node.getBoundingClientRect !== 'function') return false;
                const rect = node.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = window.getComputedStyle?.(node);
                return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
            };
            const promptNode = inputSelectors
                .flatMap(selector => Array.from(document.querySelectorAll(selector)))
                .find(isVisible) ?? inputSelectors.map(selector => document.querySelector(selector)).find(Boolean);
            const root = promptNode?.closest?.('[data-testid*="composer"]') ??
                promptNode?.closest?.('form') ??
                promptNode?.parentElement ??
                document;
            const candidates = [
                ...sendSelectors.flatMap(selector => Array.from(root.querySelectorAll?.(selector) ?? [])),
                ...sendSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector))),
            ];
            const seen = new Set<BrowserNodeLike>();
            for (const rawButton of candidates) {
                const button = rawButton;
                if (!button || seen.has(button)) continue;
                seen.add(button);
                const style = window.getComputedStyle?.(button);
                const disabled = button.hasAttribute?.('disabled') ||
                    button.getAttribute?.('aria-disabled') === 'true' ||
                    button.getAttribute?.('data-disabled') === 'true' ||
                    style?.pointerEvents === 'none' ||
                    style?.display === 'none' ||
                    style?.visibility === 'hidden';
                if (disabled || !isVisible(button)) continue;
                dispatchClickSequence(button);
                return 'clicked';
            }
            return candidates.length > 0 ? 'disabled' : 'missing';
        }, { inputSelectors: INPUT_SELECTORS, sendSelectors: SEND_BUTTON_SELECTORS }).catch(() => 'missing');
        if (result === 'clicked') return true;
        if (result === 'missing') return false;
        await page.waitForTimeout?.(100);
    }
    return false;
}

async function readConversationTurns(page: Page): Promise<string[]> {
    const locators = await page.locator(CONVERSATION_TURN_SELECTOR).all().catch(() => []);
    const turns: string[] = [];
    for (const locator of locators) {
        const text = String(await locator.innerText().catch(() => '')).trim();
        if (text) turns.push(text);
    }
    return turns;
}

async function locatorExists(page: Page, selector: string): Promise<boolean> {
    return (await page.locator(selector).first().count().catch(() => 0)) > 0;
}

function hasInsertedText(state: ComposerState, expected: string): boolean {
    const normalizedExpected = normalizePrompt(expected);
    const prefix = normalizedExpected.slice(0, Math.min(normalizedExpected.length, 120));
    return [state.editorText, state.fallbackValue, state.activeValue].some(value => normalizePrompt(value).includes(prefix));
}

function maxComposerLength(state: ComposerState): number {
    return Math.max(String(state.editorText || '').length, String(state.fallbackValue || '').length, String(state.activeValue || '').length);
}

function normalizePrompt(value: string): string {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
