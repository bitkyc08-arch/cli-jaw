/**
 * PRD32.4 — ChatGPT Answer Polling and Response Capture
 *
 * Captures only the assistant turn that landed *after* a committed baseline.
 * Filters placeholder shells, prompt echo, and "Pro Thinking" stalls. Detects
 * Canvas-opened answer state. Copy-markdown fallback is opt-in only and
 * recorded in `usedFallbacks`.
 */

import type { ResponseCaptureResult } from './provider-adapter.js';
import { ActionTranscript, captureTextBaseline } from '../primitives.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { captureCopiedResponseText, CHATGPT_COPY_SELECTORS, preferCopiedText } from './copy-markdown.js';
import { resolveActionTarget } from './self-heal.js';
import { createTraceContext, getSessionTrace, recordTraceStep } from './action-trace.js';
import type { ResolveActionTargetResult, TargetCandidate } from './self-heal.js';
import type { TraceContext, TraceStep } from './action-trace.js';
import type { Locator, Page } from 'playwright-core';

export const ASSISTANT_TURN_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];

export const CANVAS_SELECTORS = [
    '[data-testid="canvas-panel"]',
    'aside[data-testid*="canvas" i]',
    'section[aria-label*="Canvas" i]',
];

export const STOP_BUTTON_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
];

const PLACEHOLDER_PATTERNS: RegExp[] = [
    /^answer now$/i,
    /^pro thinking/i,
    /^finalizing answer$/i,
    /^thinking…?$/i,
    /^instant$/i,
    /^thinking$/i,
    /^pro$/i,
    /^configure\.{0,3}$/i,
    /^searching the web…?$/i,
    /^reading documents?$/i,
    /^analyzing files?$/i,
    /^\s*$/,
];

export function isPlaceholderAssistantText(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;
    return PLACEHOLDER_PATTERNS.some(p => p.test(trimmed));
}

export function normalizeAssistantText(text: unknown): string {
    return String(text ?? '')
        .replace(/^Thought for\s+\d+s\s*/i, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

export interface AssistantSnapshot {
    /** Number of assistant turns currently in the DOM. */
    assistantCount: number;
    /** Last assistant turn after the baseline, or undefined if none new yet. */
    latestNewText?: string;
    /** True while a stop/streaming indicator is visible. */
    streaming: boolean;
    /** True when ChatGPT routed the answer into a Canvas surface. */
    canvasOpened: boolean;
}

export interface CaptureOptions {
    /** Baseline assistant count captured before send. */
    minTurnIndex: number;
    /** Hash of the user prompt to filter prompt echo. */
    promptText?: string;
    /** Total budget. */
    timeoutMs: number;
    /** Window of stable text before declaring complete. */
    stableWindowMs?: number;
    /** Enable copy-button fallback after streaming completes. */
    allowCopyMarkdownFallback?: boolean;
    /** Polling interval in ms. */
    pollIntervalMs?: number;
}

export async function readAssistantSnapshot(page: Page, minTurnIndex: number, promptText = ''): Promise<AssistantSnapshot> {
    const allTexts = await readAssistantTexts(page);
    const streaming = await isStreaming(page);
    const canvasOpened = await isCanvasOpened(page);
    const newTexts = allTexts.slice(minTurnIndex);
    const latestNewText = pickLatestRealAnswer(newTexts, promptText);
    return stripUndefined({
        assistantCount: allTexts.length,
        latestNewText,
        streaming,
        canvasOpened,
    });
}

async function readAssistantTexts(page: Page): Promise<string[]> {
    const baseline = await captureTextBaseline(page, ASSISTANT_TURN_SELECTORS);
    if (baseline.texts.length) return baseline.texts.map(normalizeAssistantText).filter(Boolean);

    const allTexts: string[] = [];
    for (const selector of ASSISTANT_TURN_SELECTORS) {
        const locators = await safeAll(page, selector);
        for (const loc of locators) {
            const raw = await loc.innerText().catch(() => '');
            const normalized = normalizeAssistantText(raw);
            if (normalized) allTexts.push(normalized);
        }
        if (allTexts.length > 0) break;
    }
    return allTexts;
}

export async function captureAssistantResponse(page: Page, options: CaptureOptions): Promise<ResponseCaptureResult> {
    const transcript = new ActionTranscript();
    const resolverTrace = createTraceContext('chatgpt-response');
    const stableWindowMs = Math.max(250, options.stableWindowMs ?? 1500);
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    const deadline = Date.now() + Math.max(1000, options.timeoutMs);
    let stableSince: number | null = null;
    let stableText: string | undefined;

    while (Date.now() < deadline) {
        const snap = await readAssistantSnapshot(page, options.minTurnIndex, options.promptText);
        if (snap.canvasOpened) {
            return withResolverTrace(stripUndefined({
                ok: true,
                canvas: { kind: 'opened', reason: 'ChatGPT routed answer into Canvas' },
                answerText: snap.latestNewText,
                usedFallbacks: transcript.usedFallbacks,
                warnings: transcript.warnings,
            }), resolverTrace);
        }
        if (!snap.streaming && snap.latestNewText) {
            if (snap.latestNewText === stableText) {
                if (stableSince !== null && Date.now() - stableSince >= stableWindowMs) {
                    if (options.allowCopyMarkdownFallback) {
                        const copyTarget = await resolveOptionalChatGptCopyTarget(page, resolverTrace);
                        const copied = await captureCopiedResponseText(page, CHATGPT_COPY_SELECTORS, { copyTarget });
                        const copiedText = preferCopiedText(snap.latestNewText, copied);
                        if (copiedText) {
                            transcript.fallback('copy-markdown');
                            return withResolverTrace({ ok: true, answerText: normalizeAssistantText(copiedText), usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }, resolverTrace);
                        }
                        transcript.warn(`copy-markdown-fallback-unavailable:${copied.status || 'unknown'}`);
                    }
                    return withResolverTrace({ ok: true, answerText: snap.latestNewText, usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }, resolverTrace);
                }
            } else {
                stableText = snap.latestNewText;
                stableSince = Date.now();
            }
        } else {
            stableSince = null;
            stableText = undefined;
        }
        await wait(pollIntervalMs);
    }

    if (options.allowCopyMarkdownFallback && stableText) {
        const copyTarget = await resolveOptionalChatGptCopyTarget(page, resolverTrace);
        const copied = await captureCopiedResponseText(page, CHATGPT_COPY_SELECTORS, { copyTarget });
        const copiedText = preferCopiedText(stableText, copied);
        if (copiedText) {
            transcript.fallback('copy-markdown');
            return withResolverTrace({ ok: true, answerText: normalizeAssistantText(copiedText), usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }, resolverTrace);
        }
        transcript.warn(`copy-markdown-fallback-unavailable:${copied.status || 'unknown'}`);
    }
    return withResolverTrace(stripUndefined({ ok: false, answerText: stableText, usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }), resolverTrace);
}

async function resolveOptionalChatGptCopyTarget(page: Page, traceCtx: TraceContext): Promise<{ selector?: string | null } | null> {
    try {
        const result = await resolveActionTarget(page, {
            provider: 'chatgpt',
            intent: 'copy.lastResponse',
            actionKind: 'click',
        });
        recordResolverTrace(traceCtx, result, 'copy.lastResponse');
        if (result.ok && result.target?.selector) return result.target;
    } catch {
        recordTraceStep(traceCtx, {
            action: 'target-resolve',
            provider: 'chatgpt',
            intentId: 'copy.lastResponse',
            operation: 'click',
            status: 'error',
            errorCode: 'TARGET_RESOLVE_EXCEPTION',
        });
        // Copy fallback remains optional; unresolved self-heal targets use the legacy scoped scan.
    }
    return null;
}

function withResolverTrace<T extends ResponseCaptureResult>(result: T, traceCtx: TraceContext): T {
    const resolverTrace = getSessionTrace(traceCtx);
    return resolverTrace.length ? { ...result, resolverTrace } : result;
}

function recordResolverTrace(traceCtx: TraceContext, result: ResolveActionTargetResult, fallbackIntentId: string): void {
    recordTraceStep(traceCtx, stripUndefined({
        action: 'target-resolve',
        provider: result.provider || 'chatgpt',
        intentId: result.intent || fallbackIntentId,
        operation: result.actionKind || 'click',
        status: result.ok ? 'ok' : 'unresolved',
        target: scrubResolverTarget(result.target),
        confidence: result.target?.confidence ?? null,
        resolutionSource: result.target?.["resolution"] || null,
        errorCode: result.errorCode || undefined,
        attempts: summarizeResolverAttempts(result.attempts),
    }));
}

function summarizeResolverAttempts(attempts: ResolveActionTargetResult['attempts'] = []): TraceStep[] {
    return attempts.map(attempt => ({
        source: attempt.source || null,
        selector: attempt.selector || null,
        ref: attempt.ref || null,
        validation: attempt.validation ? {
            ok: attempt.validation.ok === true,
            reason: attempt.validation.reason || null,
            confidence: attempt.validation.confidence ?? null,
            count: attempt.validation.count ?? null,
        } : null,
    }));
}

function scrubResolverTarget(target: TargetCandidate | null | undefined): Record<string, unknown> | null {
    if (!target) return null;
    return {
        resolution: target["resolution"] || null,
        source: target.source || null,
        ref: target.ref || null,
        selector: target.selector || null,
        role: target.role || null,
    };
}

function pickLatestRealAnswer(texts: string[], promptText: string): string | undefined {
    const promptTrim = promptText.trim();
    for (let i = texts.length - 1; i >= 0; i -= 1) {
        const text = texts[i];
        if (text === undefined) continue;
        if (isPlaceholderAssistantText(text)) continue;
        if (promptTrim && text.trim() === promptTrim) continue;
        return text;
    }
    return undefined;
}

async function isStreaming(page: Page): Promise<boolean> {
    for (const selector of STOP_BUTTON_SELECTORS) {
        try {
            if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
        } catch {
            // ignore
        }
    }
    return false;
}

async function isCanvasOpened(page: Page): Promise<boolean> {
    for (const selector of CANVAS_SELECTORS) {
        try {
            if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
        } catch {
            // ignore
        }
    }
    return false;
}

async function safeAll(page: Page, selector: string): Promise<Locator[]> {
    try { return await page.locator(selector).all(); }
    catch { return []; }
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
