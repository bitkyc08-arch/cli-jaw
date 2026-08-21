import type { Page } from 'playwright-core';
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { getActivePage, getActiveTab } from '../connection.js';
import { WebAiError } from './errors.js';
import { normalizeEnvelope, renderQuestionEnvelope, renderQuestionEnvelopeWithContext } from './question.js';
import {
    assertSameTarget,
    createSession,
    findSessionByTarget,
    getBaseline,
    getSession,
    saveBaseline,
    updateSessionResult,
    updateSessionStatus,
} from './session.js';
import { hasContextPackaging, prepareContextForBrowser, summarizeContextPack } from './context-pack/index.js';

export const GROK_CONTEXT_PACK_WARNING = 'grok-context-pack-not-recommended: prefer inline prompts plus optional --file uploads for Grok; ChatGPT or Gemini handle context packages more reliably.';
import type { QuestionEnvelopeInput, WebAiOutput } from './types.js';
import { withPollDeadline, type PollDeadlineToken } from './poll-deadline.js';
import { classifyComposerInterstitial } from './composer-interstitial.js';
import { isPageDeathError } from './interstitial.js';
import type { WebAiFailureStage } from './diagnostics.js';
import { attachLocalFileLive } from './chatgpt-attachments.js';
import { captureCopiedResponseText, GROK_COPY_SELECTORS, preferCopiedText } from './copy-markdown.js';
import { selectGrokModel } from './grok-model.js';
import { grokCapabilityStatus } from './grok-capabilities.js';

const GROK_HOSTS = new Set(['grok.com']);
type StagedGrokError = Error & { stage?: WebAiFailureStage };
type GrokComposerElement = {
    focus(): void;
    dispatchEvent(event: Event): boolean;
};
type GrokBrowserDocument = {
    querySelector(selector: string): GrokComposerElement | null;
    execCommand(commandId: string, showUI?: boolean, value?: string): boolean;
};
type GrokInputEventConstructor = new (
    type: string,
    eventInitDict?: { data?: string; inputType?: string; bubbles?: boolean }
) => Event;
type GrokBrowserGlobal = typeof globalThis & {
    document: GrokBrowserDocument;
    InputEvent: GrokInputEventConstructor;
};
type GrokTextElement = {
    innerText?: string;
    textContent?: string | null;
};

function stagedGrokError(message: string, stage: WebAiFailureStage): StagedGrokError {
    const error = new Error(message) as StagedGrokError;
    error.stage = stage;
    return error;
}

const GROK_SELECTORS = {
    composer: ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"].ProseMirror'],
    newChat: ['[data-testid="new-chat"]'],
    assistantTurn: '[data-testid="assistant-message"]',
    userTurn: '[data-testid="user-message"]',
    responseText: '.response-content-markdown, .markdown, [class*="response-content"]',
    attachmentEvidence: [
        '[data-testid*="attachment" i]',
        '[data-testid*="file" i]',
        '[aria-label*="attachment" i]',
        '[aria-label*="file" i]',
        '[role="img"]',
    ],
    stopButton: ['button[aria-label*="Stop" i]', 'button:has-text("Stop")'],
} as const;

export function isGrokUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return GROK_HOSTS.has(host);
    } catch {
        return false;
    }
}

export async function grokStatus(port: number): Promise<WebAiOutput> {
    const tab = await getActiveTab(port).catch(() => null);
    const page = await getActivePage(port);
    if (!tab?.tab || !page) {
        return { ok: false, vendor: 'grok', status: 'blocked', warnings: [], error: 'no active grok tab/page' };
    }
    if (!isGrokUrl(page.url())) {
        return { ok: false, vendor: 'grok', status: 'blocked', url: page.url(), warnings: [`active tab is not grok.com (${page.url()})`], error: 'not grok' };
    }
    const composerSel = await findFirstSelector(page, GROK_SELECTORS.composer, 5_000);
    // 104.8: attach runtime capability-probe rows (active-tab/composer/model/upload/copy/streaming).
    const probe = await grokCapabilityStatus({ getPage: async () => page }).catch(() => ({ capabilities: [], capabilityState: 'unknown' as const }));
    return {
        ok: Boolean(composerSel),
        vendor: 'grok',
        status: composerSel ? 'ready' : 'blocked',
        url: page.url(),
        capabilityProbes: probe.capabilities,
        capabilityState: probe.capabilityState,
        warnings: composerSel ? ['grok composer visible'] : ['grok composer not visible'],
        ...(composerSel ? {} : { error: 'grok composer not visible' }),
    };
}

export async function grokSend(port: number, input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    if (!tab.tab) throw new Error('no active tab');
    const page = await getActivePage(port);
    if (!page) throw new Error('no active page');
    if (input.url) await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!isGrokUrl(page.url())) throw new Error(`active tab is not grok.com (${page.url()})`);

    const envelope = normalizeEnvelope({ ...input, vendor: 'grok' });
    if (hasContextPackaging(input) && input.allowGrokContextPack !== true) {
        throw new WebAiError({
            errorCode: 'grok.context-pack-not-allowed',
            stage: 'grok-context-pack-not-allowed',
            vendor: 'grok',
            retryHint: 'inline-only-or-allow-flag',
            message: 'grok context-pack disabled by default; pass --allow-grok-context-pack to override',
        });
    }
    const contextPack = await prepareContextForBrowser({ ...input, vendor: 'grok' });
    if (contextPack?.attachments?.[0] && input.filePath) {
        throw new Error('context package upload and --file upload cannot be combined yet');
    }
    if (envelope.attachmentPolicy !== 'inline-only' && !input.filePath && !contextPack?.attachments?.[0]) {
        throw stagedGrokError('grok upload requested without a file or context package attachment', 'attachment-preflight');
    }
    const rendered = contextPack
        ? contextPack.transport === 'inline'
            ? renderQuestionEnvelopeWithContext(envelope, contextPack.composerText)
            : renderQuestionEnvelope(envelope)
        : renderQuestionEnvelope(envelope);
    const warnings = [...rendered.warnings, ...(contextPack?.warnings || [])];
    if (hasContextPackaging(input) && input.allowGrokContextPack === true) {
        warnings.push(GROK_CONTEXT_PACK_WARNING);
    }

    await openFreshGrokChat(page, warnings);
    const composerSel = await findFirstSelector(page, GROK_SELECTORS.composer, 10_000);
    if (!composerSel) {
        // parity2 090 slice 1 (B5/C-12): interstitial re-classification before
        // the generic composer error.
        const composerError = new Error('grok composer not visible');
        const interstitialError = await classifyComposerInterstitial(page, 'grok', composerError);
        throw interstitialError ?? composerError;
    }
    const selectedModel = await selectGrokModel(page, input.model);

    const assistantCount = await countGrokAssistantMessages(page);
    await insertGrokPrompt(page, composerSel, rendered.composerText);
    const uploadPath = input.filePath || contextPack?.attachments?.[0]?.path;
    if (uploadPath) {
        const uploaded = await attachLocalFileLive(page, localFileInfo(uploadPath));
        if (!uploaded.ok) throw new Error(uploaded.error);
        warnings.push(...uploaded.warnings);
    }
    await clickGrokSubmit(page);
    if (uploadPath) {
        const sentAttachment = await verifyGrokSentTurnAttachment(page, localFileInfo(uploadPath));
        if (!sentAttachment.ok) throw new Error(sentAttachment.error);
    }

    const baseline = saveBaseline({
        vendor: 'grok',
        targetId: tab.tab.targetId,
        url: page.url(),
        envelope,
        assistantCount,
        textHash: String((await page.innerText('body').catch(() => '')).length),
    });
    const session = createSession({
        vendor: 'grok',
        targetId: tab.tab.targetId,
        url: page.url(),
        conversationUrl: page.url(),
        envelope,
        assistantCount,
        timeoutMs: 600_000,
    });
    updateSessionStatus(session.sessionId, 'streaming');
    return {
        ok: true,
        vendor: 'grok',
        status: 'sent',
        url: page.url(),
        baseline,
        sessionId: session.sessionId,
        ...(contextPack ? { contextPack: summarizeContextPack(contextPack) } : {}),
        usedFallbacks: selectedModel?.usedFallbacks || [],
        warnings: [
            ...warnings,
            ...(selectedModel ? [`model selected: ${selectedModel.selected}${selectedModel.alreadySelected ? ' (already selected)' : ''}`] : []),
            ...(contextPack?.attachments?.[0] ? [`context package attached: ${contextPack.attachments[0].displayPath}`] : []),
        ],
    };
}

function localFileInfo(filePath: string): { path: string; basename: string; sizeBytes: number } {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
    return { path: filePath, basename: basename(filePath), sizeBytes: stat.size };
}

export async function grokPoll(port: number, input: { timeout?: number | string; session?: string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    // parity2 090 slice 3 (E-06): typed errors so errorCode/retryHint consumers see them.
    if (!tab.tab) throw new WebAiError({ errorCode: 'cdp.target-mismatch', stage: 'poll-timeout', vendor: 'grok', retryHint: 'open-grok', message: 'no active tab' });
    const page = await getActivePage(port);
    if (!page) throw new WebAiError({ errorCode: 'cdp.target-mismatch', stage: 'poll-timeout', vendor: 'grok', retryHint: 'open-grok', message: 'no active page' });
    if (!isGrokUrl(page.url())) throw new WebAiError({ errorCode: 'cdp.target-mismatch', stage: 'poll-timeout', vendor: 'grok', retryHint: 'open-grok', message: `active tab is not grok.com (${page.url()})` });

    const session = input.session ? getSession(input.session) : findSessionByTarget('grok', tab.tab.targetId);
    if (session) assertSameTarget(session, tab.tab.targetId);
    const baseline = getBaseline('grok', tab.tab.targetId);
    if (!baseline) throw new WebAiError({ errorCode: 'provider.baseline-missing', stage: 'poll-timeout', vendor: 'grok', retryHint: 'send-first', message: 'baseline required. Run web-ai send --vendor grok first.' });

    const timeoutMs = Math.max(1, Number(input.timeout || 600)) * 1000;
    // parity2 010 slice 1.1 (C-04): hard bound over the whole poll.
    return withPollDeadline<WebAiOutput>(
        (_hardDeadline, token) => grokPollInner(page, input, session, baseline, timeoutMs, token),
        {
            timeoutMs,
            onExpired: () => {
                if (session) updateSessionStatus(session.sessionId, 'timeout');
                return {
                    ok: false,
                    vendor: 'grok' as const,
                    status: 'timeout' as const,
                    url: page.url(),
                    baseline,
                    ...(session ? { sessionId: session.sessionId, next: 'poll' as const } : {}),
                    usedFallbacks: [],
                    warnings: ['poll-deadline-expired: a browser probe outlived the timeout'],
                    error: 'timed out waiting for grok response',
                };
            },
        },
    );
}

async function grokPollInner(
    page: Page,
    input: { timeout?: number | string; session?: string; allowCopyMarkdownFallback?: boolean },
    session: ReturnType<typeof getSession>,
    baseline: NonNullable<ReturnType<typeof getBaseline>>,
    timeoutMs: number,
    deadlineToken: PollDeadlineToken,
): Promise<WebAiOutput> {
    const deadline = Date.now() + timeoutMs;
    let stableText = '';
    let stableSince = 0;
    while (Date.now() < deadline && !deadlineToken.expired) {
        // parity2 090 slice 2 (E-03): crashed tab → typed recoverable outcome.
        try {
        const answers = await readGrokAssistantMessages(page);
        const latest = answers.slice(baseline.assistantCount).at(-1) || '';
        const streaming = await isGrokStreaming(page);
        if (latest && !streaming) {
            if (latest === stableText) {
                if (Date.now() - stableSince >= 1500) {
                    let answerText = latest;
                    const usedFallbacks: string[] = [];
                    const warnings: string[] = [];
                    if (input.allowCopyMarkdownFallback === true) {
                        const copied = await captureCopiedResponseText(page, GROK_COPY_SELECTORS);
                        const copiedText = preferCopiedText(latest, copied);
                        if (copiedText) {
                            answerText = cleanGrokResponseText(copiedText);
                            usedFallbacks.push('copy-markdown');
                        } else {
                            warnings.push(`copy-markdown-fallback-unavailable:${copied.status || 'unknown'}`);
                        }
                    }
                    if (session) updateSessionStatus(session.sessionId, 'complete');
                    if (session) updateSessionResult({ sessionId: session.sessionId, status: 'complete', url: page.url(), conversationUrl: page.url(), answerText });
                    return {
                        ok: true,
                        vendor: 'grok',
                        status: 'complete',
                        url: page.url(),
                        answerText,
                        baseline,
                        ...(session ? { sessionId: session.sessionId } : {}),
                        usedFallbacks,
                        warnings,
                    };
                }
            } else {
                stableText = latest;
                stableSince = Date.now();
            }
        } else {
            stableText = '';
            stableSince = 0;
        }
        await page.waitForTimeout(500).catch(() => undefined);
        } catch (pollErr) {
            if (isPageDeathError(pollErr)) {
                if (session) updateSessionStatus(session.sessionId, 'crashed');
                return {
                    ok: false,
                    vendor: 'grok',
                    status: 'tab-crashed',
                    url: page.url?.() || '',
                    baseline,
                    ...(session ? { sessionId: session.sessionId, next: 'poll' as const } : {}),
                    usedFallbacks: [],
                    warnings: ['tab-crashed-during-poll'],
                    error: String((pollErr as Error)?.message || pollErr),
                    recoverable: true,
                } as WebAiOutput;
            }
            throw pollErr;
        }
    }
    if (session) updateSessionStatus(session.sessionId, 'timeout');
    if (session) updateSessionResult({ sessionId: session.sessionId, status: 'timeout', url: page.url(), conversationUrl: page.url() });
    return {
        ok: false,
        vendor: 'grok',
        status: 'timeout',
        url: page.url(),
        baseline,
        ...(session ? { sessionId: session.sessionId, next: 'poll' } : {}),
        usedFallbacks: [],
        warnings: [],
        error: 'timed out waiting for grok response',
    };
}

export async function grokStop(port: number): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    if (!tab.tab) throw new Error('no active tab');
    const page = await getActivePage(port);
    if (!page) throw new Error('no active page');
    const session = findSessionByTarget('grok', tab.tab.targetId);
    await page.keyboard.press('Escape').catch(() => undefined);
    if (session) updateSessionStatus(session.sessionId, 'complete');
    return { ok: true, vendor: 'grok', status: 'blocked', url: page.url(), warnings: ['sent Escape'] };
}

async function openFreshGrokChat(page: Page, warnings: string[]): Promise<void> {
    const existingTurns = await countGrokAssistantMessages(page);
    if (existingTurns === 0) return;
    const newChatSel = await findFirstSelector(page, GROK_SELECTORS.newChat, 5_000);
    if (!newChatSel) throw new Error('grok new chat control not visible');
    const beforeUrl = page.url();
    await page.locator(newChatSel).first().click({ timeout: 5_000 });
    await findFirstSelector(page, GROK_SELECTORS.composer, 10_000);
    const remainingTurns = await countGrokAssistantMessages(page);
    if (page.url() === beforeUrl && remainingTurns > 0) {
        warnings.push('grok new chat URL did not change; continuing because composer is visible');
    }
}

async function insertGrokPrompt(page: Page, composerSel: string, text: string): Promise<void> {
    const composer = page.locator(composerSel).first();
    await composer.click({ timeout: 5_000 }).catch(() => composer.click({ timeout: 2_000, force: true }));
    await page.evaluate(({ selector, value }) => {
        const browserGlobal = globalThis as GrokBrowserGlobal;
        const doc = browserGlobal.document;
        const InputEventCtor = browserGlobal.InputEvent;
        const el = doc.querySelector(selector);
        if (!el) throw new Error(`selector not found: ${selector}`);
        // Runtime el is an HTMLElement (page.evaluate browser context) which has focus();
        // the custom GrokBrowserGlobal document types it as the base Element, so widen via unknown.
        (el as unknown as { focus: () => void }).focus();
        doc.execCommand('selectAll', false);
        doc.execCommand('insertText', false, value);
        el.dispatchEvent(new InputEventCtor('input', { data: value, inputType: 'insertText', bubbles: true }));
    }, { selector: composerSel, value: text });
}

async function clickGrokSubmit(page: Page): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const buttons = await page.locator('button').all().catch(() => []);
        for (const button of buttons) {
            if (!await button.isVisible().catch(() => false)) continue;
            const text = (await button.innerText().catch(() => '')).trim();
            const aria = (await button.getAttribute('aria-label').catch(() => '') || '').trim();
            const disabled = await button.isDisabled().catch(() => false);
            if (!disabled && (/^Submit$/i.test(text) || /^Submit$/i.test(aria))) {
                // Scroll into view + force click to bypass "element is not stable"
                await button.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
                await button.click({ timeout: 3_000, force: true });
                return;
            }
        }
        await page.waitForTimeout(250).catch(() => undefined);
    }
    throw new Error('grok submit button not visible');
}

async function verifyGrokSentTurnAttachment(
    page: Page,
    expectedFile: { basename: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await readGrokSentTurnAttachmentEvidence(page, expectedFile);
        if (result.ok || result.error !== 'Grok sent turn has no attachment evidence') return result;
        await page.waitForTimeout(250).catch(() => undefined);
    }
    return readGrokSentTurnAttachmentEvidence(page, expectedFile);
}

async function readGrokSentTurnAttachmentEvidence(
    page: Page,
    expectedFile: { basename: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
    const turn = page.locator(GROK_SELECTORS.userTurn).last();
    if ((await turn.count().catch(() => 0)) === 0) return { ok: false, error: 'no Grok user turn visible after send' };
    const text = await turn.innerText().catch(() => '');
    if (text.includes(expectedFile.basename) || text.includes(stripExtension(expectedFile.basename))) {
        return { ok: true };
    }
    const siblingEvidence = await turn.evaluate((el, selectors) => {
        const root = el.closest('[id^="response-"]') || el.parentElement;
        if (!root) return false;
        const selectorList = selectors.join(',');
        const matches = Array.from(root.querySelectorAll(selectorList));
        return matches.some((node) => {
            const evidenceNode = node as {
                innerText?: string;
                textContent?: string | null;
                getAttribute?: (name: string) => string | null;
            };
            const text = String(evidenceNode.innerText || evidenceNode.textContent || '').trim();
            const aria = String(evidenceNode.getAttribute?.('aria-label') || '');
            return Boolean(text || aria);
        });
    }, GROK_SELECTORS.attachmentEvidence).catch(() => false);
    if (siblingEvidence) return { ok: true };
    for (const selector of GROK_SELECTORS.attachmentEvidence) {
        if (await turn.locator(selector).count().catch(() => 0) > 0) return { ok: true };
    }
    return { ok: false, error: 'Grok sent turn has no attachment evidence' };
}

async function findFirstSelector(page: Page, selectors: readonly string[], timeoutMs = 10_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            const loc = page.locator(sel).first();
            if (await loc.count().catch(() => 0) > 0 && await loc.isVisible().catch(() => false)) return sel;
        }
        await page.waitForTimeout(250).catch(() => undefined);
    }
    return null;
}

async function countGrokAssistantMessages(page: Page): Promise<number> {
    return (await readGrokAssistantMessages(page)).length;
}

async function readGrokAssistantMessages(page: Page): Promise<string[]> {
    return await page.locator(GROK_SELECTORS.assistantTurn).evaluateAll((turns, textSelector) => {
        return turns
            .map((turn) => {
                const textNodes = Array.from(turn.querySelectorAll(String(textSelector))) as GrokTextElement[];
                const candidates = textNodes.length ? textNodes : [turn as GrokTextElement];
                return candidates
                    .map((el) => String(el.innerText || el.textContent || '').trim())
                    .find(Boolean) || '';
            })
            .filter(Boolean);
    }, GROK_SELECTORS.responseText).then((items) => items.map(cleanGrokResponseText).filter(Boolean)).catch(() => []);
}

async function isGrokStreaming(page: Page): Promise<boolean> {
    for (const selector of GROK_SELECTORS.stopButton) {
        if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    }
    return false;
}

function cleanGrokResponseText(text: unknown): string {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^Thought for\s+\d+s$/i.test(line) && !/^\d+(?:\.\d+)?(?:ms|s)$/i.test(line))
        .join('\n')
        .trim();
}

function stripExtension(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx < 0 ? name : name.slice(0, idx);
}
