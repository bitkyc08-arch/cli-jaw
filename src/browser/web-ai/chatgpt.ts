import { getActivePage, getCdpSession } from '../connection.js';
import { getActiveTab, type ActiveTabResult, type BrowserTabInfo } from '../connection.js';
import { countConversationTurns } from './chatgpt-composer.js';
import { createChatGptEditorAdapter } from './vendor-editor-contract.js';
import { normalizeEnvelope, renderQuestionEnvelope } from './question.js';
import {
    assertSameTarget,
    createSession,
    findSessionByTarget,
    getBaseline,
    getSession,
    saveBaseline,
    updateSessionStatus,
} from './session.js';
import { captureAssistantResponse } from './chatgpt-response.js';
import {
    captureWebAiDiagnostics,
    type WebAiFailureStage,
} from './diagnostics.js';
import { reportGeminiContractOnlyStatus, GEMINI_DEEP_THINK_OFFICIAL_SOURCES } from './gemini-contract.js';
import { ProviderRuntimeDisabledError } from './provider-adapter.js';
import type {
    QuestionEnvelopeInput,
    WebAiOutput,
    WebAiVendor,
} from './types.js';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];
const PLACEHOLDER_PATTERNS = [/^answer now$/i, /^pro thinking/i, /^finalizing answer$/i, /^\s*$/];

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
    const vendor = parseVendor(input.vendor);
    if (vendor === 'gemini') {
        const report = reportGeminiContractOnlyStatus();
        return {
            ok: false,
            vendor: 'gemini',
            status: 'blocked',
            warnings: [...report.notes, `sources: ${report.sources.join(' ')}`],
            error: `gemini runtime disabled (PRD32.8A contract-only). docs: ${GEMINI_DEEP_THINK_OFFICIAL_SOURCES[0]}`,
        };
    }
    const active = await requireVerifiedChatGptTab(port, vendor);
    return { ok: true, vendor: 'chatgpt', status: 'ready', url: active.url, warnings: [] };
}

export async function send(port: number, input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const requestedVendor = parseVendor(input.vendor);
    if (requestedVendor === 'gemini') {
        throw stageError(
            new ProviderRuntimeDisabledError('gemini', 'send-click'),
            'send-click',
        );
    }
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
    const session = createSession({
        vendor: envelope.vendor,
        targetId: active.targetId,
        url: active.url,
        conversationUrl: active.url,
        envelope,
        assistantCount,
        timeoutMs: 600_000,
    });

    const adapter = createChatGptEditorAdapter(page, {
        insertText: async (text: string) => {
            const cdp = await getCdpSession(port);
            try {
                await cdp.send('Input.insertText', { text });
            } finally {
                await cdp.detach?.().catch(() => undefined);
            }
        },
    });
    try {
        await adapter.waitForReady();
        const commitBaseline = { turnsCount: await countConversationTurns(page).catch(() => assistantCount) };
        await adapter.insertPrompt(rendered.composerText);
        await adapter.submitPrompt();
        await adapter.verifyPromptCommitted(rendered.composerText, commitBaseline);
        updateSessionStatus(session.sessionId, 'streaming');
    } catch (e) {
        updateSessionStatus(session.sessionId, 'error');
        throw stageError(e, 'send-click');
    }
    return {
        ok: true,
        vendor: envelope.vendor,
        status: 'sent',
        url: active.url,
        baseline,
        sessionId: session.sessionId,
        warnings: rendered.warnings,
    };
}

export async function poll(port: number, input: { vendor?: string; timeout?: number | string; session?: string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    if (vendor === 'gemini') {
        throw stageError(
            new ProviderRuntimeDisabledError('gemini', 'poll-timeout'),
            'poll-timeout',
        );
    }
    const active = await requireVerifiedChatGptTab(port, vendor);
    let session = input.session ? getSession(input.session) : findSessionByTarget(vendor, active.targetId);
    const baseline = getBaseline(vendor, active.targetId);
    if (!baseline) throw stageError(new Error('baseline required. Run web-ai send or query first.'), 'poll-timeout');
    if (session) assertSameTarget(session, active.targetId);

    const page = await requireActivePage(port);
    const timeoutMs = Math.max(1, Number(input.timeout || 600)) * 1000;
    const result = await captureAssistantResponse(page, {
        minTurnIndex: baseline.assistantCount,
        timeoutMs,
        promptText: '',
        allowCopyMarkdownFallback: input.allowCopyMarkdownFallback === true,
    });
    if (session && result.ok) updateSessionStatus(session.sessionId, 'complete');
    if (session && !result.ok) updateSessionStatus(session.sessionId, 'timeout');
    if (result.canvas) {
        return {
            ok: true,
            vendor,
            status: 'complete',
            url: active.url,
            answerText: result.answerText,
            canvas: result.canvas,
            baseline,
            ...(session ? { sessionId: session.sessionId } : {}),
            usedFallbacks: result.usedFallbacks,
            warnings: result.warnings,
        };
    }
    if (result.ok) {
        return {
            ok: true,
            vendor,
            status: 'complete',
            url: active.url,
            answerText: result.answerText,
            baseline,
            ...(session ? { sessionId: session.sessionId } : {}),
            usedFallbacks: result.usedFallbacks,
            warnings: result.warnings,
        };
    }
    return {
        ok: false,
        vendor,
        status: 'timeout',
        url: active.url,
        baseline,
        ...(session ? { sessionId: session.sessionId, next: 'poll' } : {}),
        usedFallbacks: result.usedFallbacks,
        warnings: result.warnings,
        error: 'timed out waiting for answer',
    };
}

export async function query(port: number, input: QuestionEnvelopeInput & { timeout?: number | string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const sent = await send(port, input);
    return poll(port, {
        vendor: sent.vendor,
        timeout: input.timeout,
        session: sent.sessionId,
        allowCopyMarkdownFallback: input.allowCopyMarkdownFallback,
    });
}

export async function stop(port: number, input: { vendor?: string } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    if (vendor === 'gemini') {
        throw stageError(new ProviderRuntimeDisabledError('gemini', 'send-click'), 'send-click');
    }
    const active = await requireVerifiedChatGptTab(port, vendor);
    const page = await requireActivePage(port);
    const session = findSessionByTarget(vendor, active.targetId);
    if (session) assertSameTarget(session, active.targetId);
    await page.keyboard.press('Escape');
    if (session) updateSessionStatus(session.sessionId, 'complete');
    return { ok: true, vendor: 'chatgpt', status: 'blocked', url: active.url, warnings: ['sent Escape to stop generation'] };
}

export async function diagnose(port: number, input: { vendor?: string; stage?: string } = {}): Promise<{ ok: boolean; diagnostics?: ReturnType<typeof toJsonDiagnostics> }> {
    const vendor = parseVendor(input.vendor);
    const stage = (input.stage as WebAiFailureStage) || 'unknown';
    if (vendor === 'gemini') {
        return { ok: false, diagnostics: undefined };
    }
    const page = await requireActivePage(port).catch(() => null);
    if (!page) return { ok: false };
    const diagnostics = await captureWebAiDiagnostics({ stage, page });
    return { ok: true, diagnostics: toJsonDiagnostics(diagnostics) };
}

function toJsonDiagnostics<T>(d: T): T { return d; }

function stageError(error: unknown, stage: WebAiFailureStage): Error {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (!(wrapped as any).stage) (wrapped as any).stage = stage;
    return wrapped;
}

function parseVendor(vendor?: string): WebAiVendor {
    if (!vendor || vendor === 'chatgpt') return 'chatgpt';
    if (vendor === 'gemini') return 'gemini';
    throw new Error(`unsupported vendor: ${vendor}`);
}

async function requireVerifiedChatGptTab(port: number, vendor?: string): Promise<BrowserTabInfo> {
    const parsed = parseVendor(vendor);
    if (parsed === 'gemini') {
        throw stageError(new ProviderRuntimeDisabledError('gemini', 'status'), 'status');
    }
    const active: ActiveTabResult = await getActiveTab(port);
    if (!active.ok || !active.tab) {
        throw stageError(
            new Error(`active tab is not verified (${active.reason || 'unknown'}). Run tabs --json then tab-switch before web-ai.`),
            'status',
        );
    }
    if (!isChatGptUrl(active.tab.url)) {
        throw stageError(
            new Error(`active tab is not ChatGPT: ${active.tab.url}. Run tabs --json then tab-switch before web-ai.`),
            'status',
        );
    }
    return active.tab;
}

async function requireActivePage(port: number): Promise<any> {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    return page;
}

async function countAssistantMessages(page: any): Promise<number> {
    return (await readAssistantMessages(page)).length;
}

async function readAssistantMessages(page: any): Promise<string[]> {
    const messages: string[] = [];
    for (const selector of ASSISTANT_SELECTORS) {
        const locators = await page.locator(selector).all().catch(() => []);
        for (const locator of locators) {
            const text = cleanAssistantText(await locator.innerText().catch(() => ''));
            if (text) messages.push(text);
        }
        if (messages.length > 0) break;
    }
    return messages;
}

function isFinalAnswer(text: string): boolean {
    return !PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text));
}

function cleanAssistantText(text: unknown): string {
    return String(text || '')
        .replace(/^Thought for\s+\d+s\s*/i, '')
        .trim();
}
