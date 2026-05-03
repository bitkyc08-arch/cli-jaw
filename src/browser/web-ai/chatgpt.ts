import { getActivePage, getCdpSession, createTab, waitForPageByTargetId, getPageByTargetId } from '../connection.js';
import { getActiveTab, type ActiveTabResult, type BrowserTabInfo } from '../connection.js';
import { withSessionCommandLock } from './session-store.js';
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { countConversationTurns } from './chatgpt-composer.js';
import {
    attachLocalFileLive,
    verifySentTurnAttachmentLive,
} from './chatgpt-attachments.js';
import { createChatGptEditorAdapter } from './vendor-editor-contract.js';
import { normalizeEnvelope, renderQuestionEnvelope, renderQuestionEnvelopeWithContext } from './question.js';
import {
    assertSameTarget,
    bindSessionToTab,
    createSession,
    findSessionByTarget,
    getBaseline,
    getSession,
    incrementRecoveryCount,
    listSessions,
    pruneSessions,
    saveBaseline,
    updateSessionResult,
    updateSessionStatus,
    updateSessionTabState,
} from './session.js';
import { captureAssistantResponse } from './chatgpt-response.js';
import { selectChatGptModel } from './chatgpt-model.js';
import { listActiveWebAiWatchers, resumeStoredWebAiWatchers, startWebAiWatcher } from './watcher.js';
import {
    captureWebAiDiagnostics,
    type WebAiFailureStage,
} from './diagnostics.js';
import { reportGeminiContractOnlyStatus, GEMINI_DEEP_THINK_OFFICIAL_SOURCES } from './gemini-contract.js';
import { geminiSend, geminiPoll, geminiStop, geminiStatus } from './gemini-live.js';
import { grokSend, grokPoll, grokStop, grokStatus, isGrokUrl } from './grok-live.js';
import { ProviderRuntimeDisabledError } from './provider-adapter.js';
import { fromCliJawStructuredError, WebAiError } from './errors.js';
import { listCapabilitySchemas } from './capability-registry.js';
import { prepareContextForBrowser, summarizeContextPack } from './context-pack/index.js';
import type {
    QuestionEnvelopeInput,
    WebAiOutput,
    WebAiVendor,
} from './types.js';

declare const document: any;

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];
const PLACEHOLDER_PATTERNS = [
    /^answer now$/i,
    /^pro thinking/i,
    /^finalizing answer$/i,
    /^instant$/i,
    /^thinking$/i,
    /^pro$/i,
    /^configure\.{0,3}$/i,
    /^\s*$/,
];

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
    const contextPack = await prepareContextForBrowser(input);
    const rendered = contextPack
        ? contextPack.transport === 'inline'
            ? renderQuestionEnvelopeWithContext(envelope, contextPack.composerText)
            : renderQuestionEnvelope(envelope)
        : renderQuestionEnvelope(envelope);
    return {
        ok: true,
        vendor: envelope.vendor,
        status: 'rendered',
        rendered,
        ...(contextPack ? { contextPack: summarizeContextPack(contextPack) } : {}),
        warnings: [...rendered.warnings, ...(contextPack?.warnings || [])],
    };
}

export async function status(port: number, input: { vendor?: string; probe?: string } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    let inner: WebAiOutput;
    if (vendor === 'gemini') {
        inner = await geminiStatus(port);
    } else if (vendor === 'grok') {
        inner = await grokStatus(port);
    } else {
        const active = await requireVerifiedChatGptTab(port, vendor);
        inner = { ok: true, vendor: 'chatgpt', status: 'ready', url: active.url, warnings: [] };
    }
    const allRows = listCapabilitySchemas({ vendor: vendor as any });
    const rows = input.probe
        ? allRows.filter((row: { capabilityId: string }) => row.capabilityId === input.probe)
        : allRows;
    return {
        ...inner,
        capabilities: rows,
    } as WebAiOutput;
}

async function ensureProviderTab(port: number, input: QuestionEnvelopeInput): Promise<{ page: any; targetId: string }> {
    const reuseTab = input.reuseTab === true || process.env.JAW_REUSE_TAB === '1';
    if (reuseTab) {
        const active = await requireVerifiedChatGptTab(port, input.vendor);
        const page = await requireActivePage(port);
        return { page, targetId: active.targetId };
    }
    const vendorUrl = input.url || 'https://chatgpt.com';
    const tab = await createTab(port, vendorUrl, { activate: false });
    const page = await waitForPageByTargetId(port, tab.targetId);
    return { page, targetId: tab.targetId };
}

async function withSessionPage(port: number, sessionId: string, fn: (ctx: { page: any; targetId: string; session: any }) => Promise<any>): Promise<any> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    async function resolvePage(forceRecover = false) {
        const current = getSession(sessionId);
        if (!current) throw new Error(`Session not found: ${sessionId}`);
        const alive = current.targetId ? !!(await getPageByTargetId(port, current.targetId).catch(() => null)) : false;
        if (!alive || forceRecover) {
            const tab = await createTab(port, current.conversationUrl || current.url || 'https://chatgpt.com', { activate: false });
            const page = await waitForPageByTargetId(port, tab.targetId);
            updateSessionResult({ sessionId, status: current.status, tabState: { createdAt: current.tabState?.createdAt || new Date().toISOString(), lastActiveAt: new Date().toISOString(), recoveryCount: (current.tabState?.recoveryCount || 0) + 1, closeCount: current.tabState?.closeCount || 0 } });
            const recovered = getSession(sessionId);
            return { page, targetId: tab.targetId, session: recovered || current };
        }
        const page = await getPageByTargetId(port, current.targetId);
        if (!page) throw new Error(`Session ${sessionId} page not found for targetId ${current.targetId}`);
        return { page, targetId: current.targetId, session: current };
    }
    const first = await resolvePage();
    try {
        return await fn(first);
    } catch (err: any) {
        const msg = String(err?.message || err || '').toLowerCase();
        const isPageDeath = msg.includes('target closed') || msg.includes('page closed') || msg.includes('browser has been closed') || msg.includes('crash');
        if (!isPageDeath) throw err;
        const recovered = await resolvePage(true);
        return fn(recovered);
    }
}

async function runBoundCommand(port: number, command: string, input: any, pollFn: any, stopFn: any): Promise<any> {
    if (['poll', 'stop'].includes(command) && input.session) {
        return withSessionCommandLock(input.session, async () => {
            return withSessionPage(port, input.session, async ({ page, targetId, session }) => {
                if (command === 'poll') return pollFn(port, { ...input, vendor: session.vendor, session: session.sessionId });
                if (command === 'stop') return stopFn(port, { ...input, vendor: session.vendor, session: session.sessionId });
            });
        });
    }
    if (command === 'poll') return pollFn(port, input);
    if (command === 'stop') return stopFn(port, input);
    throw new Error(`runBoundCommand: unsupported command ${command}`);
}

export async function send(port: number, input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const requestedVendor = parseVendor(input.vendor);
    if (requestedVendor === 'gemini') {
        try {
            return await geminiSend(port, input);
        } catch (e) {
            throw stageError(e, 'send-click');
        }
    }
    if (requestedVendor === 'grok') {
        try {
            return await grokSend(port, input);
        } catch (e) {
            throw stageError(e, 'send-click');
        }
    }
    const envelope = normalizeEnvelope(input);
    const { page, targetId } = await ensureProviderTab(port, input);
    const contextPack = await prepareContextForBrowser(input);
    const rendered = contextPack
        ? contextPack.transport === 'inline'
            ? renderQuestionEnvelopeWithContext(envelope, contextPack.composerText)
            : renderQuestionEnvelope(envelope)
        : renderQuestionEnvelope(envelope);
    const selectedModel = await selectChatGptModel(page, input.model);
    await waitForStableAssistantCount(page);
    const assistantCount = await countAssistantMessages(page);
    const baseline = saveBaseline({
        vendor: envelope.vendor,
        targetId,
        url: page.url(),
        envelope,
        assistantCount,
        textHash: String((await page.innerText('body').catch(() => '')).length),
    });
    const session = createSession({
        vendor: envelope.vendor,
        targetId,
        url: page.url(),
        conversationUrl: page.url(),
        envelope,
        assistantCount,
        timeoutMs: 600_000,
    });
    bindSessionToTab(session.sessionId, targetId);

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
        const contextAttachmentPath = contextPack?.attachments?.[0]?.path;
        if (contextAttachmentPath && input.filePath) {
            throw new Error('context package upload and --file upload cannot be combined yet');
        }
        const uploadPath = input.filePath || contextAttachmentPath;
        if (uploadPath) {
            const info = localFileInfo(uploadPath);
            const uploaded = await attachLocalFileLive(page, info);
            if (!uploaded.ok) throw new Error(uploaded.error);
        }
        await adapter.submitPrompt();
        await adapter.verifyPromptCommitted(rendered.composerText, commitBaseline);
        if (uploadPath) {
            const sentAttachment = await verifySentTurnAttachmentLive(page, localFileInfo(uploadPath));
            if (!sentAttachment.ok) throw new Error(sentAttachment.error);
        }
        updateSessionStatus(session.sessionId, 'streaming');
    } catch (e) {
        updateSessionStatus(session.sessionId, 'error');
        throw stageError(e, 'send-click');
    }
    return {
        ok: true,
        vendor: envelope.vendor,
        status: 'sent',
        url: page.url(),
        baseline,
        sessionId: session.sessionId,
        ...(contextPack ? { contextPack: summarizeContextPack(contextPack) } : {}),
        usedFallbacks: selectedModel?.usedFallbacks,
        warnings: [
            ...rendered.warnings,
            ...(contextPack?.warnings || []),
            ...(contextPack?.attachments?.[0] ? [`context package attached: ${contextPack.attachments[0].displayPath}`] : []),
            ...(selectedModel ? [`model selected: ${selectedModel.selected}${selectedModel.alreadySelected ? ' (already selected)' : ''}`] : []),
        ],
    };
}

function localFileInfo(filePath: string): { path: string; basename: string; sizeBytes: number } {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
    return { path: filePath, basename: basename(filePath), sizeBytes: stat.size };
}

export async function poll(port: number, input: { vendor?: string; timeout?: number | string; session?: string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    if (vendor === 'gemini') {
        try {
            return await geminiPoll(port, {
                timeout: input.timeout,
                session: input.session,
                allowCopyMarkdownFallback: input.allowCopyMarkdownFallback === true,
            });
        } catch (e) {
            throw stageError(e, 'poll-timeout');
        }
    }
    if (vendor === 'grok') {
        try {
            return await grokPoll(port, {
                timeout: input.timeout,
                session: input.session,
                allowCopyMarkdownFallback: input.allowCopyMarkdownFallback === true,
            });
        } catch (e) {
            throw stageError(e, 'poll-timeout');
        }
    }

    let page: any;
    let targetId: string;
    let session = input.session ? getSession(input.session) : null;

    if (session) {
        const ctx = await withSessionPage(port, session.sessionId, async (c) => c);
        page = ctx.page;
        targetId = ctx.targetId;
    } else {
        const active = await requireVerifiedChatGptTab(port, vendor);
        targetId = active.targetId;
        page = await requireActivePage(port);
        session = findSessionByTarget(vendor, targetId);
    }

    const baseline = getBaseline(vendor, targetId);
    if (!baseline) throw new WebAiError({
        errorCode: 'provider.poll-timeout',
        stage: 'poll-timeout',
        vendor,
        retryHint: 'poll-or-resume',
        message: 'baseline required. Run web-ai send or query first.',
    });
    if (session) assertSameTarget(session, targetId);
    const currentUrl = page.url?.() || session?.url || 'https://chatgpt.com';
    const timeoutMs = Math.max(1, Number(input.timeout || 1200)) * 1000;
    const result = await captureAssistantResponse(page, {
        minTurnIndex: baseline.assistantCount,
        timeoutMs,
        promptText: '',
        allowCopyMarkdownFallback: input.allowCopyMarkdownFallback === true,
    });
    if (session && result.ok) updateSessionStatus(session.sessionId, 'complete');
    if (session && !result.ok) updateSessionStatus(session.sessionId, 'timeout');
    if (result.canvas) {
        if (session) updateSessionResult({ sessionId: session.sessionId, status: 'complete', url: currentUrl, conversationUrl: currentUrl, answerText: result.answerText });
        return {
            ok: true,
            vendor,
            status: 'complete',
            url: currentUrl,
            answerText: result.answerText,
            canvas: result.canvas,
            baseline,
            ...(session ? { sessionId: session.sessionId } : {}),
            usedFallbacks: result.usedFallbacks,
            warnings: result.warnings,
        };
    }
    if (result.ok) {
        if (session) updateSessionResult({ sessionId: session.sessionId, status: 'complete', url: currentUrl, conversationUrl: currentUrl, answerText: result.answerText });
        return {
            ok: true,
            vendor,
            status: 'complete',
            url: currentUrl,
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
        url: currentUrl,
        baseline,
        ...(session ? { sessionId: session.sessionId, next: 'poll' } : {}),
        usedFallbacks: result.usedFallbacks,
        warnings: result.warnings,
        error: 'timed out waiting for answer',
    };
}

export async function query(port: number, input: QuestionEnvelopeInput & { timeout?: number | string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const sent = await send(port, input);
    const result = await poll(port, {
        vendor: sent.vendor,
        timeout: input.timeout,
        session: sent.sessionId,
        allowCopyMarkdownFallback: input.allowCopyMarkdownFallback,
    });
    return {
        ...result,
        usedFallbacks: [...(sent.usedFallbacks || []), ...(result.usedFallbacks || [])],
        warnings: [...(sent.warnings || []), ...(result.warnings || [])],
    };
}

export async function watch(port: number, input: { vendor?: string; timeout?: number | string; session?: string; url?: string; notify?: boolean; pollIntervalSeconds?: number | string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    if (input.url) await navigateRequestedConversation(port, input.url, parseVendor(input.vendor));
    if (input.session && input.notify !== false) {
        const vendor = parseVendor(input.vendor);
        const watcher = startWebAiWatcher({
            port,
            vendor,
            sessionId: input.session,
            timeoutMs: Math.max(1, Number(input.timeout || 1200)) * 1000,
            pollIntervalSeconds: Number(input.pollIntervalSeconds || 30),
            allowCopyMarkdownFallback: input.allowCopyMarkdownFallback,
            pollOnce: (pollInput) => poll(port, pollInput),
        });
        return {
            ok: true,
            vendor,
            status: 'streaming',
            sessionId: input.session,
            next: 'poll',
            warnings: [`watcher ${watcher.status}: ${watcher.sessionId}`],
        };
    }
    return poll(port, input);
}

export function watchers(): WebAiOutput {
    return {
        ok: true,
        vendor: 'chatgpt',
        status: 'ready',
        watchers: listActiveWebAiWatchers() as any,
        warnings: [],
    } as WebAiOutput;
}

export function resumeStoredWatchers(port: number, input: { vendor?: string; pollIntervalSeconds?: number | string } = {}): WebAiOutput {
    const vendor = input.vendor ? parseVendor(input.vendor) : undefined;
    const resumed = resumeStoredWebAiWatchers({
        port,
        vendor,
        pollIntervalSeconds: Number(input.pollIntervalSeconds || 30),
        pollOnce: (pollInput) => poll(port, pollInput),
    });
    return {
        ok: true,
        vendor: vendor || 'chatgpt',
        status: 'ready',
        watchers: resumed as any,
        warnings: resumed.length ? [`resumed ${resumed.length} web-ai watcher(s)`] : [],
    } as WebAiOutput;
}

export async function sessions(input: { vendor?: string; status?: string } = {}): Promise<WebAiOutput> {
    const vendor = input.vendor ? parseVendor(input.vendor) : undefined;
    const status = input.status as any;
    return {
        ok: true,
        vendor: vendor || 'chatgpt',
        status: 'ready',
        sessions: listSessions({ vendor, status }),
        warnings: [],
    };
}

export async function sessionsPrune(input: { olderThanMs?: number | string; before?: string; status?: string } = {}): Promise<WebAiOutput> {
    const ms = typeof input.olderThanMs === 'string' ? Number(input.olderThanMs) : input.olderThanMs;
    const result = pruneSessions({
        ...(typeof ms === 'number' && Number.isFinite(ms) ? { olderThanMs: ms } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(input.status ? { status: input.status as any } : {}),
    });
    return {
        ok: true,
        vendor: 'chatgpt',
        status: 'ready',
        prune: result,
        warnings: [],
    } as WebAiOutput;
}

export async function stop(port: number, input: { vendor?: string; session?: string } = {}): Promise<WebAiOutput> {
    const vendor = parseVendor(input.vendor);
    if (vendor === 'gemini') {
        try { return await geminiStop(port); } catch (e) { throw stageError(e, 'send-click'); }
    }
    if (vendor === 'grok') {
        try { return await grokStop(port); } catch (e) { throw stageError(e, 'send-click'); }
    }

    let page: any;
    let targetId: string;
    let session = input.session ? getSession(input.session) : null;

    if (session) {
        const ctx = await withSessionPage(port, session.sessionId, async (c) => c);
        page = ctx.page;
        targetId = ctx.targetId;
    } else {
        const active = await requireVerifiedChatGptTab(port, vendor);
        targetId = active.targetId;
        page = await requireActivePage(port);
        session = findSessionByTarget(vendor, targetId);
    }

    if (session) assertSameTarget(session, targetId);
    await page.keyboard.press('Escape');
    if (session) updateSessionStatus(session.sessionId, 'complete');
    const currentUrl = page.url?.() || session?.url || 'https://chatgpt.com';
    return { ok: true, vendor: 'chatgpt', status: 'blocked', url: currentUrl, warnings: ['sent Escape to stop generation'] };
}

export async function diagnose(port: number, input: { vendor?: string; stage?: string } = {}): Promise<{ ok: boolean; diagnostics?: ReturnType<typeof toJsonDiagnostics> }> {
    const vendor = parseVendor(input.vendor);
    const stage = (input.stage as WebAiFailureStage) || 'unknown';
    const page = await requireActivePage(port).catch(() => null);
    if (!page) return { ok: false };
    const diagnostics = await captureWebAiDiagnostics({ stage, page });
    return { ok: true, diagnostics: toJsonDiagnostics({ ...diagnostics, vendor }) };
}

function toJsonDiagnostics<T>(d: T): T { return d; }

function stageError(error: unknown, stage: WebAiFailureStage): Error {
    const mapped = fromCliJawStructuredError(error, stage);
    if (mapped) {
        if (!mapped.stage || mapped.stage === 'internal') mapped.stage = stage;
        return mapped;
    }
    if (error instanceof WebAiError) {
        if (!error.stage || error.stage === 'internal') error.stage = stage;
        return error;
    }
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (!(wrapped as { stage?: string }).stage) (wrapped as { stage?: string }).stage = stage;
    return wrapped;
}

function parseVendor(vendor?: string): WebAiVendor {
    if (!vendor || vendor === 'chatgpt') return 'chatgpt';
    if (vendor === 'gemini') return 'gemini';
    if (vendor === 'grok') return 'grok';
    throw new WebAiError({
        errorCode: 'provider.runtime-disabled',
        stage: 'provider-runtime-gate',
        retryHint: 'enable-or-skip',
        message: `unsupported vendor: ${vendor}`,
        evidence: { vendor },
    });
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

async function navigateRequestedConversation(port: number, url: string | undefined, vendor: WebAiVendor): Promise<void> {
    if (!url) return;
    const page = await requireActivePage(port);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const loadedUrl = page.url();
    if (vendor === 'chatgpt' && !isChatGptUrl(loadedUrl)) {
        throw stageError(new Error(`requested URL did not load ChatGPT: ${loadedUrl}`), 'status');
    }
    if (vendor === 'grok' && !isGrokUrl(loadedUrl)) {
        throw stageError(new Error(`requested URL did not load Grok: ${loadedUrl}`), 'status');
    }
}

async function requireActivePage(port: number): Promise<any> {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    return page;
}

async function countAssistantMessages(page: any): Promise<number> {
    return (await readAssistantMessages(page)).length;
}

async function waitForStableAssistantCount(page: any, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = -1;
    let stableReads = 0;
    while (Date.now() < deadline) {
        const count = await countAssistantMessages(page).catch(() => 0);
        if (count === previous) stableReads++;
        else stableReads = 0;
        previous = count;
        if (stableReads >= 2) return;
        await page.waitForTimeout(500).catch(() => undefined);
    }
}

async function readAssistantMessages(page: any): Promise<string[]> {
    const evaluated = await page.evaluate?.((selectors: readonly string[]) => {
        for (const selector of selectors) {
            const texts = Array.from(document.querySelectorAll(selector))
                .map((el: any) => String(el.innerText || el.textContent || '').trim())
                .filter(Boolean);
            if (texts.length) return texts;
        }
        return [];
    }, ASSISTANT_SELECTORS).catch(() => []);
    if (evaluated?.length) return evaluated.map(cleanAssistantText).filter(Boolean);

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
