import { getActivePage } from '../connection.js';
import { getActiveTab, type ActiveTabResult, type BrowserTabInfo } from '../connection.js';
import { normalizeEnvelope, renderQuestionEnvelope } from './question.js';
import { getBaseline, saveBaseline } from './session.js';
import type { QuestionEnvelopeInput, WebAiOutput, WebAiVendor } from './types.js';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[name="prompt-textarea"]',
    'textarea[data-id="prompt-textarea"]',
    '.ProseMirror',
    '[contenteditable="true"]',
];
const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];
const PLACEHOLDER_PATTERNS = [/^answer now$/i, /^pro thinking/i, /^\s*$/];

export function isChatGptUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return CHATGPT_HOSTS.has(host);
    } catch {
        return false;
    }
}

export async function render(input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const envelope = normalizeEnvelope(input);
    const rendered = renderQuestionEnvelope(envelope);
    return { ok: true, vendor: envelope.vendor, status: 'rendered', rendered, warnings: rendered.warnings };
}

export async function status(port: number, input: { vendor?: string } = {}): Promise<WebAiOutput> {
    const active = await requireVerifiedChatGptTab(port, input.vendor);
    return { ok: true, vendor: 'chatgpt', status: 'ready', url: active.url, warnings: [] };
}

export async function send(port: number, input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const envelope = normalizeEnvelope(input);
    const active = await requireVerifiedChatGptTab(port, envelope.vendor);
    const page = await requireActivePage(port);
    const rendered = renderQuestionEnvelope(envelope);
    const assistantCount = await countAssistantMessages(page);
    const baseline = saveBaseline({
        vendor: envelope.vendor,
        targetId: active.targetId,
        url: active.url,
        envelope,
        assistantCount,
        textHash: String((await page.innerText('body').catch(() => '')).length),
    });

    const composer = await findComposer(page);
    await fillComposer(composer, rendered.composerText);
    await verifyComposer(composer, rendered.composerText);
    await page.keyboard.press('Enter');
    return { ok: true, vendor: envelope.vendor, status: 'sent', url: active.url, baseline, warnings: rendered.warnings };
}

export async function poll(port: number, input: { vendor?: string; timeout?: number | string } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    const active = await requireVerifiedChatGptTab(port, vendor);
    const baseline = getBaseline(vendor, active.targetId);
    if (!baseline) throw new Error('baseline required. Run web-ai send or query first.');

    const page = await requireActivePage(port);
    const timeout = Math.max(1, Number(input.timeout || 600));
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() <= deadline) {
        const answers = await readAssistantMessages(page);
        const newAnswers = answers.slice(baseline.assistantCount).filter(isFinalAnswer);
        const answerText = newAnswers[newAnswers.length - 1];
        if (answerText) {
            return { ok: true, vendor, status: 'complete', url: active.url, answerText, baseline, warnings: [] };
        }
        await page.waitForTimeout(500);
    }
    return { ok: false, vendor, status: 'timeout', url: active.url, baseline, warnings: [], error: 'timed out waiting for answer' };
}

export async function query(port: number, input: QuestionEnvelopeInput & { timeout?: number | string } = {}): Promise<WebAiOutput> {
    const sent = await send(port, input);
    return poll(port, { vendor: sent.vendor, timeout: input.timeout });
}

export async function stop(port: number, input: { vendor?: string } = {}): Promise<WebAiOutput> {
    const active = await requireVerifiedChatGptTab(port, input.vendor);
    const page = await requireActivePage(port);
    await page.keyboard.press('Escape');
    return { ok: true, vendor: 'chatgpt', status: 'blocked', url: active.url, warnings: ['sent Escape to stop generation'] };
}

function parseVendor(vendor?: string): WebAiVendor {
    if (!vendor || vendor === 'chatgpt') return 'chatgpt';
    throw new Error(`unsupported vendor: ${vendor}`);
}

async function requireVerifiedChatGptTab(port: number, vendor?: string): Promise<BrowserTabInfo> {
    parseVendor(vendor);
    const active: ActiveTabResult = await getActiveTab(port);
    if (!active.ok || !active.tab) {
        throw new Error(`active tab is not verified (${active.reason || 'unknown'}). Run tabs --json then tab-switch before web-ai.`);
    }
    if (!isChatGptUrl(active.tab.url)) {
        throw new Error(`active tab is not ChatGPT: ${active.tab.url}. Run tabs --json then tab-switch before web-ai.`);
    }
    return active.tab;
}

async function requireActivePage(port: number): Promise<any> {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    return page;
}

async function findComposer(page: any): Promise<any> {
    for (const selector of COMPOSER_SELECTORS) {
        const locator = page.locator(selector).first();
        if (await locator.count().catch(() => 0)) {
            await locator.waitFor({ state: 'visible', timeout: 5000 });
            return locator;
        }
    }
    throw new Error(`ChatGPT composer not found. Tried: ${COMPOSER_SELECTORS.join(', ')}`);
}

async function fillComposer(locator: any, text: string): Promise<void> {
    await locator.fill(text).catch(async () => {
        await locator.click();
        await locator.evaluate((node: {
            textContent: string | null;
            dispatchEvent: (event: unknown) => boolean;
            ownerDocument?: {
                defaultView?: {
                    InputEvent?: new (type: string, init?: Record<string, unknown>) => unknown;
                    Event?: new (type: string, init?: Record<string, unknown>) => unknown;
                };
            };
        }, value: string) => {
            node.textContent = value;
            const view = node.ownerDocument?.defaultView;
            const EventCtor = view?.InputEvent ?? view?.Event;
            if (EventCtor) {
                node.dispatchEvent(new EventCtor('input', { bubbles: true, inputType: 'insertText', data: value }));
            }
        }, text);
    });
}

async function verifyComposer(locator: any, expected: string): Promise<void> {
    const actual = await locator.inputValue().catch(async () => locator.innerText().catch(() => ''));
    if (!String(actual).includes(expected.slice(0, Math.min(expected.length, 120)))) {
        throw new Error('composer verification failed after prompt insertion');
    }
}

async function countAssistantMessages(page: any): Promise<number> {
    return (await readAssistantMessages(page)).length;
}

async function readAssistantMessages(page: any): Promise<string[]> {
    const messages: string[] = [];
    for (const selector of ASSISTANT_SELECTORS) {
        const locators = await page.locator(selector).all().catch(() => []);
        for (const locator of locators) {
            const text = String(await locator.innerText().catch(() => '')).trim();
            if (text) messages.push(text);
        }
        if (messages.length > 0) break;
    }
    return messages;
}

function isFinalAnswer(text: string): boolean {
    return !PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text));
}
