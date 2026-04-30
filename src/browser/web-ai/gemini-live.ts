/**
 * PRD32.8B — Gemini Deep Think Live Runtime
 *
 * Mutation-enabled runtime that drives gemini.google.com via the selectors
 * captured in `gemini-contract.ts`. Mirrors the chatgpt.ts contract:
 *   - geminiSend: open New chat → Tools → Deep think → type prompt → click Send
 *   - geminiPoll: wait for `.response-footer.complete`, capture `message-content`
 *   - geminiStatus: detect signed-out / no-ultra / disabled-state
 *
 * Account/plan UI is the source of truth for limits; we never hardcode them.
 * All fallbacks must be recorded in `usedFallbacks[]` (no silent fallback).
 */

import type { Page } from 'playwright-core';
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { getActivePage, getActiveTab } from '../connection.js';
import { GEMINI_DEEP_THINK_SELECTORS, GEMINI_DEEP_THINK_OFFICIAL_SOURCES, GEMINI_DEEP_THINK_CONSTRAINTS, type GeminiAccountStatus, type GeminiStatusReport } from './gemini-contract.js';
import { normalizeEnvelope, renderQuestionEnvelope, renderQuestionEnvelopeWithContext } from './question.js';
import {
    createSession,
    findSessionByTarget,
    getBaseline,
    getSession,
    saveBaseline,
    updateSessionResult,
    updateSessionStatus,
    assertSameTarget,
} from './session.js';
import type { QuestionEnvelopeInput, WebAiOutput } from './types.js';
import { prepareContextForBrowser, summarizeContextPack } from './context-pack/index.js';
import { captureCopiedResponseText, GEMINI_COPY_SELECTORS, preferCopiedText } from './copy-markdown.js';
import { selectGeminiModel } from './gemini-model.js';
import { preflightAttachment } from './chatgpt-attachments.js';

const GEMINI_HOSTS = new Set(['gemini.google.com']);

export function isGeminiUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return GEMINI_HOSTS.has(host);
    } catch {
        return false;
    }
}

async function findFirstSelector(page: Page, selectors: readonly string[], timeoutMs = 10_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0) {
                    const visible = await loc.isVisible().catch(() => false);
                    if (visible) return sel;
                }
            } catch {
                // continue
            }
        }
        await page.waitForTimeout(250).catch(() => undefined);
    }
    return null;
}

export interface GeminiLiveStatusReport extends Omit<GeminiStatusReport, 'runtimeEnabled' | 'status'> {
    runtimeEnabled: true;
    status: GeminiAccountStatus | 'ready';
}

export async function reportGeminiLiveStatus(page: Page): Promise<GeminiLiveStatusReport> {
    const url = page.url();
    const notes: string[] = [];
    if (!isGeminiUrl(url)) {
        return {
            vendor: 'gemini',
            status: 'gemini-unavailable',
            runtimeEnabled: true,
            notes: [`active tab is not gemini.google.com (${url})`],
            sources: [...GEMINI_DEEP_THINK_OFFICIAL_SOURCES],
        };
    }
    const signedOut = await page.locator('a[href*="accounts.google.com"]').first().isVisible().catch(() => false);
    if (signedOut) {
        return {
            vendor: 'gemini',
            status: 'signed-out',
            runtimeEnabled: true,
            notes: ['google sign-in link visible — user is not signed in'],
            sources: [...GEMINI_DEEP_THINK_OFFICIAL_SOURCES],
        };
    }
    const inputSel = await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.input, 5_000);
    if (!inputSel) {
        notes.push('gemini composer not visible — page may be loading or restricted');
        return {
            vendor: 'gemini',
            status: 'gemini-unavailable',
            runtimeEnabled: true,
            notes,
            sources: [...GEMINI_DEEP_THINK_OFFICIAL_SOURCES],
        };
    }
    return {
        vendor: 'gemini',
        status: 'ready',
        runtimeEnabled: true,
        notes: ['gemini composer visible'],
        sources: [...GEMINI_DEEP_THINK_OFFICIAL_SOURCES],
    };
}

export async function geminiStatus(port: number): Promise<WebAiOutput> {
    const tab = await getActiveTab(port).catch(() => null);
    if (!tab || !tab.tab) {
        return { ok: false, vendor: 'gemini', status: 'blocked', warnings: [], error: 'no active tab' };
    }
    const page = await getActivePage(port);
    if (!page) {
        return { ok: false, vendor: 'gemini', status: 'blocked', warnings: [], error: 'no active page' };
    }
    const report = await reportGeminiLiveStatus(page);
    return {
        ok: report.status === 'ready',
        vendor: 'gemini',
        status: report.status === 'ready' ? 'ready' : 'blocked',
        url: page.url(),
        warnings: report.notes,
        ...(report.status !== 'ready' ? { error: `gemini status: ${report.status}` } : {}),
    };
}

export interface GeminiLiveSendResult {
    ok: true;
    sessionId: string;
    targetId: string;
    url: string;
    usedFallbacks: string[];
    warnings: string[];
    deepThinkActivated: boolean;
}

async function ensureDeepThinkMode(page: Page, fallbacks: string[], warnings: string[]): Promise<boolean> {
    if (await isDeepThinkToolActive(page)) return true;
    const clickedTools = await clickToolsButton(page);
    const toolsSel = clickedTools ? null : await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.toolsButton, 5_000);
    if (!clickedTools && !toolsSel) {
        warnings.push('tools button not found — Deep Think mode not activated; using default mode');
        return false;
    }
    try {
        if (!toolsSel) {
            await page.waitForTimeout(300).catch(() => undefined);
        } else {
            await page.locator(toolsSel).first().click({ timeout: 5_000 });
        }
    } catch (e) {
        warnings.push(`tools button click failed: ${(e as Error).message}`);
        return false;
    }
    await page.waitForTimeout(300).catch(() => undefined);
    if (await clickDeepThinkMenuItem(page)) {
        await page.waitForTimeout(700).catch(() => undefined);
        if (await isDeepThinkToolActive(page)) {
            await dismissBlockingOverlays(page, warnings);
            return true;
        }
    }
    const deepSel = await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.deepThinkMenuItem, 2_000);
    if (!deepSel) {
        warnings.push('deep-think tool menu item not found — likely no Ultra/Ultra-for-Business plan');
        await page.keyboard.press('Escape').catch(() => undefined);
        return false;
    }
    try {
        await page.locator(deepSel).first().click({ timeout: 5_000 });
        await page.waitForTimeout(700).catch(() => undefined);
        if (await isDeepThinkToolActive(page)) {
            await dismissBlockingOverlays(page, warnings);
            return true;
        }
        await dismissBlockingOverlays(page, warnings);
        await page.waitForTimeout(300).catch(() => undefined);
        return isDeepThinkToolActive(page);
    } catch (e) {
        fallbacks.push('deep-think-click-failed');
        warnings.push(`deep-think tool click failed: ${(e as Error).message}`);
        return false;
    }
}

async function clickToolsButton(page: Page): Promise<boolean> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const buttons = await page.locator('button').all().catch(() => []);
        for (const button of buttons) {
            const visible = await button.isVisible().catch(() => false);
            if (!visible) continue;
            const text = await button.innerText().catch(() => '');
            const aria = await button.getAttribute('aria-label').catch(() => '');
            if (text.trim() !== 'Tools' && !/Tools/i.test(aria || '')) continue;
            await button.click({ timeout: 3_000 });
            return true;
        }
        await page.waitForTimeout(250).catch(() => undefined);
    }
    return false;
}

async function clickDeepThinkMenuItem(page: Page): Promise<boolean> {
    const items = await page.locator('[role="menuitemcheckbox"], [role="menuitem"], button').all().catch(() => []);
    for (const item of items) {
        const visible = await item.isVisible().catch(() => false);
        if (!visible) continue;
        const text = (await item.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
        if (text !== 'Deep think') continue;
        await item.click({ timeout: 3_000 });
        return true;
    }
    return false;
}

export async function geminiSend(port: number, input: QuestionEnvelopeInput = {}): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    if (!tab.tab) throw new Error('no active tab');
    const page = await getActivePage(port);
    if (!page) throw new Error('no active page');
    if (input.url) {
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    if (!isGeminiUrl(page.url())) {
        throw new Error(`active tab is not gemini.google.com (${page.url()})`);
    }
    const envelope = normalizeEnvelope({ ...input, vendor: 'gemini' });
    const contextPack = await prepareContextForBrowser({ ...input, vendor: 'gemini' });
    if (contextPack?.attachments?.[0] && input.filePath) {
        throw new Error('context package upload and --file upload cannot be combined yet');
    }
    if (envelope.attachmentPolicy !== 'inline-only' && !input.filePath && !contextPack?.attachments?.[0]) {
        const err = new Error('gemini upload requested without a file or context package attachment');
        (err as any).stage = 'attachment-preflight';
        throw err;
    }
    const rendered = contextPack
        ? contextPack.transport === 'inline'
            ? renderQuestionEnvelopeWithContext(envelope, contextPack.composerText)
            : renderQuestionEnvelope(envelope)
        : renderQuestionEnvelopeWithContext(envelope, undefined);
    const usedFallbacks: string[] = [];
    const warnings: string[] = [...rendered.warnings, ...(contextPack?.warnings || [])];

    await openFreshGeminiChat(page, warnings);
    const inputSel = await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.input, 10_000);
    if (!inputSel) throw new Error('gemini composer not visible');

    const selectedModel = await selectGeminiModel(page, input.model);
    if (selectedModel) {
        usedFallbacks.push(...selectedModel.usedFallbacks);
        warnings.push(`model selected: ${selectedModel.selected}${selectedModel.alreadySelected ? ' (already selected)' : ''}`);
    } else {
        const deepActivated = await ensureDeepThinkMode(page, usedFallbacks, warnings);
        if (!deepActivated) {
            const err = new Error('gemini Deep Think requested but active Deep Think chip was not verified; fail closed before prompt submit');
            (err as any).stage = 'provider-select-mode';
            throw err;
        }
        warnings.push('deep-think activated');
    }

    await dismissBlockingOverlays(page, warnings);
    await clearGeminiComposerAttachments(page, warnings);
    await page.locator(inputSel).first().click({ timeout: 5_000 });
    await page.keyboard.type(rendered.composerText, { delay: 5 });
    const uploadPath = input.filePath || contextPack?.attachments?.[0]?.path;
    if (uploadPath) {
        const uploaded = await attachGeminiLocalFileLive(page, localFileInfo(uploadPath));
        if (!uploaded.ok) throw new Error(uploaded.error);
        usedFallbacks.push(...uploaded.usedFallbacks);
        warnings.push(...uploaded.warnings);
    }

    const sendSel = await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.sendButton, 5_000);
    if (!sendSel) throw new Error('gemini send button not visible');

    const turnsBefore = await page.locator(GEMINI_DEEP_THINK_SELECTORS.responseTurn[0]).count().catch(() => 0);
    await page.locator(sendSel).first().click({ timeout: 5_000 });
    if (uploadPath) {
        const sentAttachment = await verifyGeminiSentTurnAttachment(page, localFileInfo(uploadPath));
        if (!sentAttachment.ok) throw new Error(sentAttachment.error);
    }

    const baseline = saveBaseline({
        vendor: 'gemini',
        targetId: tab.tab.targetId,
        url: page.url(),
        envelope,
        assistantCount: turnsBefore,
        textHash: String((await page.innerText('body').catch(() => '')).length),
    });
    const session = createSession({
        vendor: 'gemini',
        targetId: tab.tab.targetId,
        url: page.url(),
        conversationUrl: page.url(),
        envelope,
        assistantCount: turnsBefore,
        timeoutMs: Math.max(GEMINI_DEEP_THINK_CONSTRAINTS.minimumWaitMs, 900_000),
    });
    updateSessionStatus(session.sessionId, 'streaming');
    return {
        ok: true,
        vendor: 'gemini',
        status: 'sent',
        url: page.url(),
        baseline,
        sessionId: session.sessionId,
        ...(contextPack ? { contextPack: summarizeContextPack(contextPack) } : {}),
        usedFallbacks,
        warnings: [
            ...warnings,
            ...(contextPack?.attachments?.[0] ? [`context package attached: ${contextPack.attachments[0].displayPath}`] : []),
        ],
    };
}

function localFileInfo(filePath: string): { path: string; basename: string; sizeBytes: number } {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
    return { path: filePath, basename: basename(filePath), sizeBytes: stat.size };
}

async function attachGeminiLocalFileLive(
    page: Page,
    file: { path: string; basename: string; sizeBytes: number },
): Promise<{ ok: true; usedFallbacks: string[]; warnings: string[] } | { ok: false; error: string; usedFallbacks: string[] }> {
    const usedFallbacks: string[] = [];
    const warnings: string[] = [];
    const preflight = preflightAttachment(file);
    if (!preflight.ok) {
        return { ok: false, error: preflight.rejectedReason || 'preflight rejected', usedFallbacks };
    }
    warnings.push(...preflight.softWarnings);

    const uploadButton = await findFirstSelector(page, ['button[aria-label="Open upload file menu"]', 'button[aria-label*="upload file menu" i]'], 5_000);
    if (!uploadButton) return { ok: false, error: 'gemini upload file menu button not visible', usedFallbacks };

    try {
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.locator(uploadButton).first().click({ timeout: 5_000 });
        const uploadItem = page.locator('[role="menuitem"][aria-label^="Upload files"], button[aria-label^="Upload files"]').first();
        await uploadItem.waitFor({ state: 'visible', timeout: 5_000 });
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
        await uploadItem.click({ timeout: 5_000, force: true });
        const chooser = await chooserPromise;
        await chooser.setFiles(file.path);
    } catch (e) {
        usedFallbacks.push(`gemini-filechooser-failed:${(e as Error).message}`);
        return { ok: false, error: `gemini file chooser upload failed: ${(e as Error).message}`, usedFallbacks };
    }

    const accepted = await waitForGeminiAttachmentAccepted(page, file);
    if (!accepted.ok) return { ok: false, error: accepted.error, usedFallbacks };
    return { ok: true, usedFallbacks, warnings };
}

async function waitForGeminiAttachmentAccepted(
    page: Page,
    expectedFile: { basename: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        if (await hasGeminiAttachmentEvidence(page, expectedFile)) return { ok: true };
        const busy = await page.locator('[role="progressbar"], [aria-label*="uploading" i], [aria-label*="processing" i]').count().catch(() => 0);
        if (busy === 0) await page.waitForTimeout(500).catch(() => undefined);
        else await page.waitForTimeout(1_000).catch(() => undefined);
    }
    return { ok: false, error: 'gemini attachment never showed visible chip' };
}

async function clearGeminiComposerAttachments(page: Page, warnings: string[]): Promise<void> {
    const removeButtons = await page.locator('button[aria-label^="Remove file"]').all().catch(() => []);
    for (const button of removeButtons) {
        try {
            await button.click({ timeout: 2_000 });
        } catch (e) {
            warnings.push(`gemini attachment remove failed: ${(e as Error).message}`);
        }
    }
}

async function verifyGeminiSentTurnAttachment(
    page: Page,
    expectedFile: { basename: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        if (await hasGeminiAttachmentEvidence(page, expectedFile)) return { ok: true };
        await page.waitForTimeout(500).catch(() => undefined);
    }
    return { ok: false, error: 'Gemini sent turn has no attachment evidence' };
}

async function hasGeminiAttachmentEvidence(page: Page, expectedFile: { basename: string }): Promise<boolean> {
    const expected = [expectedFile.basename, stripExtension(expectedFile.basename), expectedFile.basename.replace(/\(\d+\)(?=\.)/, '')]
        .filter(Boolean);
    const bodyText = await page.innerText('body').catch(() => '');
    if (expected.some((name) => bodyText.includes(name))) return true;
    const chipCount = await page.locator([
        'uploader-file-preview',
        '.file-preview-chip',
        '.attachment-preview-wrapper',
        '.file-preview-container',
        'button[aria-label^="Remove file"]',
    ].join(',')).count().catch(() => 0);
    return chipCount > 0;
}

function stripExtension(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx < 0 ? name : name.slice(0, idx);
}

async function openFreshGeminiChat(page: Page, warnings: string[]): Promise<void> {
    const beforeUrl = page.url();
    const newChatSel = await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.newChat, 5_000);
    if (!newChatSel) {
        const existingTurns = await page.locator(GEMINI_DEEP_THINK_SELECTORS.responseTurn[0]).count().catch(() => 0);
        if (existingTurns === 0) return;
        throw new Error('gemini new chat control not visible');
    }
    await page.locator(newChatSel).first().click({ timeout: 5_000 });
    await page.waitForTimeout(1_000).catch(() => undefined);
    await findFirstSelector(page, GEMINI_DEEP_THINK_SELECTORS.input, 10_000);
    const existingTurns = await page.locator(GEMINI_DEEP_THINK_SELECTORS.responseTurn[0]).count().catch(() => 0);
    if (page.url() === beforeUrl && existingTurns > 0) {
        warnings.push('new chat URL did not change; continuing only because composer is visible');
    }
}

async function isDeepThinkToolActive(page: Page): Promise<boolean> {
    for (const sel of GEMINI_DEEP_THINK_SELECTORS.deepThinkActive) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    return false;
}

async function dismissBlockingOverlays(page: Page, warnings: string[]): Promise<void> {
    const backdrop = page.locator('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing').first();
    if (!await backdrop.isVisible().catch(() => false)) return;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
    if (await backdrop.isVisible().catch(() => false)) {
        await backdrop.click({ timeout: 2_000, force: true }).catch((e: unknown) => warnings.push(`overlay backdrop dismiss failed: ${(e as Error).message}`));
    }
    if (await backdrop.isVisible().catch(() => false)) warnings.push('overlay backdrop remained visible before composer focus');
}

export async function geminiPoll(port: number, input: { timeout?: number | string; session?: string; allowCopyMarkdownFallback?: boolean } = {}): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    if (!tab.tab) throw new Error('no active tab');
    const page = await getActivePage(port);
    if (!page) throw new Error('no active page');
    const session = input.session ? getSession(input.session) : findSessionByTarget('gemini', tab.tab.targetId);
    if (session) assertSameTarget(session, tab.tab.targetId);
    const baseline = getBaseline('gemini', tab.tab.targetId);
    if (!baseline) throw new Error('baseline required. Run web-ai send --vendor gemini first.');
    const timeoutMs = Math.max(
        GEMINI_DEEP_THINK_CONSTRAINTS.minimumWaitMs,
        Number(input.timeout || 900) * 1000,
    );
    const deadline = Date.now() + timeoutMs;
    const completionSel = GEMINI_DEEP_THINK_SELECTORS.completionSignal[0];
    const responseSel = GEMINI_DEEP_THINK_SELECTORS.responseTurn[0];
    const textSel = GEMINI_DEEP_THINK_SELECTORS.responseText[0];
    while (Date.now() < deadline) {
        const turns = await page.locator(responseSel).count().catch(() => 0);
        if (turns > baseline.assistantCount) {
            const lastTurn = page.locator(responseSel).nth(turns - 1);
            const completed = await lastTurn.locator(completionSel).count().catch(() => 0);
            if (completed > 0) {
                const text = await readGeminiResponseText(lastTurn, textSel);
                if (text && text.trim()) {
                    if (isPendingDeepThinkText(text)) {
                        await page.waitForTimeout(5_000).catch(() => undefined);
                        continue;
                    }
                    let answerText = text.trim();
                    const usedFallbacks: string[] = [];
                    const warnings: string[] = [];
                    if (input.allowCopyMarkdownFallback === true) {
                        const copied = await captureCopiedResponseText(page, GEMINI_COPY_SELECTORS);
                        const copiedText = preferCopiedText(answerText, copied);
                        if (copiedText) {
                            answerText = normalizeGeminiResponseText(copiedText);
                            usedFallbacks.push('copy-markdown');
                        } else {
                            warnings.push(`copy-markdown-fallback-unavailable:${copied.status || 'unknown'}`);
                        }
                    }
                    if (session) updateSessionStatus(session.sessionId, 'complete');
                    if (session) updateSessionResult({ sessionId: session.sessionId, status: 'complete', url: page.url(), conversationUrl: page.url(), answerText });
                    return {
                        ok: true,
                        vendor: 'gemini',
                        status: 'complete',
                        url: page.url(),
                        answerText,
                        baseline,
                        ...(session ? { sessionId: session.sessionId } : {}),
                        usedFallbacks,
                        warnings,
                    };
                }
            }
        }
        await page.waitForTimeout(2_000).catch(() => undefined);
    }
    if (session) updateSessionStatus(session.sessionId, 'timeout');
    if (session) updateSessionResult({ sessionId: session.sessionId, status: 'timeout', url: page.url(), conversationUrl: page.url() });
    return {
        ok: false,
        vendor: 'gemini',
        status: 'timeout',
        url: page.url(),
        baseline,
        ...(session ? { sessionId: session.sessionId, next: 'poll' } : {}),
        usedFallbacks: [],
        warnings: [],
        error: 'timed out waiting for gemini deep-think response',
    };
}

async function readGeminiResponseText(turn: ReturnType<Page['locator']>, textSel: string): Promise<string> {
    const candidates: string[] = [];
    const textLocs = await turn.locator(textSel).all().catch(() => []);
    for (const loc of textLocs) candidates.push(await loc.innerText().catch(() => ''));
    candidates.push(await turn.innerText().catch(() => ''));
    return candidates.map(normalizeGeminiResponseText).find((candidate) => candidate.trim()) || '';
}

function normalizeGeminiResponseText(text: string): string {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(show thinking|gemini said)$/i.test(line))
        .join('\n')
        .trim();
}

function isPendingDeepThinkText(text: string): boolean {
    return /(?:responses with deep think can take some time|generating your response|check back later|i'?m on it)/i.test(String(text || ''));
}

export async function geminiStop(port: number): Promise<WebAiOutput> {
    const tab = await getActiveTab(port);
    if (!tab.tab) throw new Error('no active tab');
    const page = await getActivePage(port);
    if (!page) throw new Error('no active page');
    const session = findSessionByTarget('gemini', tab.tab.targetId);
    await page.keyboard.press('Escape').catch(() => undefined);
    if (session) updateSessionStatus(session.sessionId, 'complete');
    return {
        ok: true,
        vendor: 'gemini',
        status: 'blocked',
        url: page.url(),
        warnings: ['sent Escape; gemini live runtime cannot guarantee abort mid-thinking'],
    };
}
