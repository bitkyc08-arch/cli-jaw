import type { PromptCommitBaseline, PromptCommitResult, PromptSubmitResult, VendorEditorAdapterOptions } from './vendor-editor-contract.js';

declare const document: any;
declare const window: any;
declare const PointerEvent: any;
declare const MouseEvent: any;
declare const InputEvent: any;
declare const Event: any;
declare const HTMLTextAreaElement: any;
declare const HTMLInputElement: any;

export const INPUT_SELECTORS = [
    'textarea[data-id="prompt-textarea"]',
    'textarea[placeholder*="Send a message"]',
    'textarea[aria-label="Message ChatGPT"]',
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
    'form button[type="submit"]',
    'button[type="submit"][data-testid*="send"]',
    'button[aria-label*="Send"]',
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
    locator: any; // Playwright Locator shape from playwright-core; kept local to avoid public API exposure.
};

export async function findComposerCandidate(page: any): Promise<ComposerCandidate> {
    let firstCandidate: ComposerCandidate | null = null;
    for (const selector of INPUT_SELECTORS) {
        const baseLocator = page.locator(selector);
        const count = await baseLocator.count().catch(() => 0);
        if (!count) continue;
        for (let index = 0; index < count; index += 1) {
            const locator = typeof baseLocator.nth === 'function' ? baseLocator.nth(index) : baseLocator.first();
            const candidate = { selector, locator };
            firstCandidate ??= candidate;
            if (await isLocatorVisible(locator)) {
                return candidate;
            }
        }
    }
    if (firstCandidate) return firstCandidate;
    throw new Error(`ChatGPT composer not found. Tried: ${INPUT_SELECTORS.join(', ')}`);
}

export async function insertPromptIntoComposer(page: any, text: string, options: VendorEditorAdapterOptions = {}): Promise<void> {
    const candidate = await findComposerCandidate(page);
    await focusComposerLikeUser(candidate.locator);
    try {
        await insertTextLikeOracle(page, text, options);
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

export async function submitPromptFromComposer(page: any): Promise<PromptSubmitResult> {
    const clicked = await clickEnabledSendButton(page);
    if (clicked) return { method: 'button' };
    await page.keyboard.press('Enter');
    return { method: 'enter' };
}

export async function verifyPromptCommitted(
    page: any,
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

export async function countConversationTurns(page: any): Promise<number> {
    return (await readConversationTurns(page)).length;
}

async function focusComposerLikeUser(locator: any): Promise<void> {
    await locator.click().catch(() => undefined);
    await locator.evaluate?.((node: any) => {
        const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const type of types) {
            const common = { bubbles: true, cancelable: true, view: window };
            const event = type.startsWith('pointer') && 'PointerEvent' in window
                ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
                : new MouseEvent(type, common);
            node.dispatchEvent(event);
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

async function insertTextLikeOracle(page: any, text: string, options: VendorEditorAdapterOptions = {}): Promise<void> {
    if (typeof options.insertText === 'function') {
        await options.insertText(text);
        return;
    }
    await page.keyboard.insertText(text);
}

async function isLocatorVisible(locator: any): Promise<boolean> {
    const waited = await locator.waitFor?.({ state: 'visible', timeout: 500 }).then(() => true).catch(() => false);
    if (waited) return true;
    const box = await locator.boundingBox?.().catch(() => null);
    if (box && box.width > 0 && box.height > 0) return true;
    return Boolean(await locator.evaluate?.((node: any) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle?.(node);
        return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
    }).catch(() => false));
}

async function writeComposerFallback(page: any, locator: any, text: string): Promise<void> {
    if (typeof page.evaluate === 'function') {
        const wrote = await page.evaluate((selectors: readonly string[], value: string) => {
            const write = (node: any): boolean => {
                if (!node) return false;
                if ('value' in node) {
                    node.value = value;
                    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
                    node.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                node.textContent = value;
                node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
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
        }, INPUT_SELECTORS, text).catch(() => false);
        if (wrote) return;
    }
    await locator.evaluate((node: any, value: string) => {
        if ('value' in node) {
            node.value = value;
            node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        node.textContent = value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
    }, text);
}

async function readComposerState(page: any, fallbackLocator?: any): Promise<ComposerState> {
    if (typeof page.evaluate === 'function') {
        const value = await page.evaluate((selectors: readonly string[]) => {
            const read = (node: any): string => {
                if (!node) return '';
                if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value || '';
                return node.innerText || node.textContent || '';
            };
            const isVisible = (node: any): boolean => {
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

async function clickEnabledSendButton(page: any): Promise<boolean> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const result = await page.evaluate((inputSelectors: readonly string[], sendSelectors: readonly string[]) => {
            const dispatchClickSequence = (target: any): boolean => {
                if (!target || !(target instanceof EventTarget)) return false;
                for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                    const common = { bubbles: true, cancelable: true, view: window };
                    const event = type.startsWith('pointer') && 'PointerEvent' in window
                        ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
                        : new MouseEvent(type, common);
                    target.dispatchEvent(event);
                }
                return true;
            };
            const isVisible = (node: any): boolean => {
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
                ...sendSelectors.flatMap(selector => Array.from(root.querySelectorAll(selector))),
                ...sendSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector))),
            ];
            const seen = new Set();
            for (const rawButton of candidates) {
                const button: any = rawButton;
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
        }, INPUT_SELECTORS, SEND_BUTTON_SELECTORS).catch(() => 'missing');
        if (result === 'clicked') return true;
        if (result === 'missing') return false;
        await page.waitForTimeout?.(100);
    }
    return false;
}

async function readConversationTurns(page: any): Promise<string[]> {
    const locators = await page.locator(CONVERSATION_TURN_SELECTOR).all().catch(() => []);
    const turns: string[] = [];
    for (const locator of locators) {
        const text = String(await locator.innerText().catch(() => '')).trim();
        if (text) turns.push(text);
    }
    return turns;
}

async function locatorExists(page: any, selector: string): Promise<boolean> {
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
