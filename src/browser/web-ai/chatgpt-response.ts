/**
 * PRD32.4 — ChatGPT Answer Polling and Response Capture
 *
 * Captures only the assistant turn that landed *after* a committed baseline.
 * Filters placeholder shells, prompt echo, and "Pro Thinking" stalls. Detects
 * Canvas-opened answer state. Copy-markdown fallback is opt-in only and
 * recorded in `usedFallbacks`.
 */

import type { ResponseCaptureResult } from './provider-adapter.js';
import { ActionTranscript } from '../primitives.js';
import {
    readTopLevelAssistantTexts,
    readTopLevelAssistantTextsFromLocators,
    readAssistantTurnOrderingInPage,
    probeStopButton,
    scopeToMainRegion,
    resolveTopLevelAssistantTurns,
    CHATGPT_ASSISTANT_SELECTORS,
    type ChatGptTurnOrderingInPage,
    type ChatGptStopVerdict,
} from './chatgpt-response-dom.js';
import { observeAssistantResponse, recoverAssistantResponse } from './chatgpt-response-observer.js';
import { stripUndefined } from '../../core/strip-undefined.js';
import { captureCopiedResponseText, CHATGPT_COPY_SELECTORS, preferCopiedText } from './copy-markdown.js';
import { resolveActionTarget } from './self-heal.js';
import { isPageDeathError } from './interstitial.js';
import { createTraceContext, getSessionTrace, recordTraceStep } from './action-trace.js';
import { withPollDeadline, type PollDeadlineToken } from './poll-deadline.js';
import type { ResolveActionTargetResult, TargetCandidate } from './self-heal.js';
import type { TraceContext, TraceStep } from './action-trace.js';
import type { Page } from 'playwright-core';

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

const FINISHED_ACTIONS_SELECTOR = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[data-testid="bad-response-turn-action-button"]',
    'button[aria-label="Share"]',
].join(', ');

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
    // parity2 050 slice B-10: placeholder drift since the 2606 port (agbrowse chatgpt.mjs:103-118).
    /^stopped thinking$/i,
    /^reasoning$/i,
    /^deep thinking$/i,
    /^searching…?$/i,
    /^browsing…?$/i,
    /^chatgpt said: answer now$/i,
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
    /** parity2 050 (B-03): tri-state activity verdict; 'unknown' = failed read, fail closed. */
    activity?: 'visible' | 'absent' | 'unknown';
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
    /**
     * 104.18: per-tick conversation-drift guard. Returns a reason string when the held tab has
     * drifted to a different conversation (poll should bail), or null to keep polling.
     */
    driftCheck?: () => Promise<string | null>;
}

export async function readAssistantSnapshot(page: Page, minTurnIndex: number, promptText = ''): Promise<AssistantSnapshot> {
    const allTexts = await readAssistantTexts(page);
    // parity2 050 slice B-03: tri-state verdict; 'unknown' must NOT read as
    // "not streaming" — the caller demands a quiet window before accepting.
    const activity = await probeActivity(page);
    const streaming = activity === 'visible';
    const canvasOpened = await isCanvasOpened(page);
    const newTexts = allTexts.slice(minTurnIndex);
    const latestNewText = pickLatestRealAnswer(newTexts, promptText);
    return stripUndefined({
        assistantCount: allTexts.length,
        latestNewText,
        streaming,
        activity,
        canvasOpened,
    });
}

async function readAssistantTexts(page: Page): Promise<string[]> {
    // Descendant-dedup (catalog 106.13): prefer top-level assistant nodes so a nested
    // match never double-counts its parent's text. page.evaluate first, locator fallback.
    // parity2 050 slice B-08: each snapshot read races a 10s cap so one
    // huge-DOM evaluate cannot eat the whole poll budget.
    const viaEvaluate = await withPollDeadline<string[]>(
        () => page.evaluate(readTopLevelAssistantTexts, ASSISTANT_TURN_SELECTORS).catch(() => [] as string[]),
        { timeoutMs: 10_000, onExpired: () => [] as string[] },
    );
    // parity2 040 (C-09): the locator fallback now reports unread-vs-empty; a
    // partial read is discarded upstream, so only the texts survive here.
    const texts = viaEvaluate.length
        ? viaEvaluate
        : (await readTopLevelAssistantTextsFromLocators(page, ASSISTANT_TURN_SELECTORS)).texts;
    return texts.map(normalizeAssistantText).filter(Boolean);
}

export async function captureAssistantResponse(page: Page, options: CaptureOptions): Promise<ResponseCaptureResult> {
    // parity2 010 slice 1.1 (C-04): the loop below checks its deadline only BETWEEN
    // awaited probes, so a single never-settling evaluate/locator call would defeat
    // the timeout. The hard-deadline race answers the caller regardless; the token
    // lets the losing tick refuse late side effects.
    const timeoutMs = Math.max(1000, options.timeoutMs);
    return withPollDeadline(
        (_hardDeadline, token) => captureAssistantResponseInner(page, options, token),
        {
            timeoutMs,
            onExpired: () => ({
                ok: false,
                warnings: ['poll-deadline-expired: a browser probe outlived the timeout'],
            } as ResponseCaptureResult),
        },
    );
}

async function captureAssistantResponseInner(page: Page, options: CaptureOptions, deadlineToken: PollDeadlineToken): Promise<ResponseCaptureResult> {
    const transcript = new ActionTranscript();
    const resolverTrace = createTraceContext('chatgpt-response');
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    // parity2 050 slice B-12: stderr progress heartbeat for long polls.
    const pollStartedAt = Date.now();
    let lastHeartbeatAt = pollStartedAt;
    // The post-loop tiers (copy fallback, 3rd-tier recovery) must run INSIDE the
    // outer hard deadline, so the loop stops early enough to leave them room:
    // 20% of the budget, clamped to [200ms, 2s].
    const budgetMs = Math.max(1000, options.timeoutMs);
    const recoveryReserveMs = Math.min(2000, Math.max(200, Math.floor(budgetMs * 0.2)));
    const deadline = Date.now() + Math.max(200, budgetMs - recoveryReserveMs);
    let stableSince: number | null = null;
    let stableText: string | undefined;

    // 101 #2 early-wake: a MutationObserver wakes the loop as soon as the response settles.
    // The poller stays authoritative — this only reduces latency (worst case = identical polling).
    const observerBudgetMs = Math.min(Math.max(0, deadline - Date.now()), 120_000);
    let observerWake: Promise<{ settled: true } | null> | null = observerBudgetMs > 1000
        ? observeAssistantResponse(page, { baselineAssistantCount: options.minTurnIndex, timeoutMs: observerBudgetMs })
        : null;

    while (Date.now() < deadline && !deadlineToken.expired) {
        try {
            // 104.18: per-tick guard — if the held tab drifted to a different chat, stop polling the
            // wrong thread and report it so the caller can rebind instead of timing out on stale DOM.
            if (options.driftCheck) {
                const driftReason = await options.driftCheck();
                if (driftReason) {
                    return withResolverTrace(stripUndefined({
                        ok: false,
                        drift: { status: 'conversation-mismatch', reason: driftReason },
                        usedFallbacks: transcript.usedFallbacks,
                        warnings: [...transcript.warnings, `conversation-drift:${driftReason}`],
                    }), resolverTrace);
                }
            }
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
                    const finished = await isResponseFinished(page, options.minTurnIndex);
                    // parity2 050 slice B-03: an UNKNOWN activity probe is not
                    // "not streaming" — demand the long quiet window and never
                    // take the fast finished path on top of a failed read.
                    const activityUnknown = snap.activity === 'unknown';
                    const textLen = snap.latestNewText.length;
                    const adaptiveMs = (finished && !activityUnknown) ? 1000
                        : activityUnknown ? 5000
                        : textLen < 16 ? 8000
                        : textLen < 40 ? 3000
                        : textLen < 500 ? 2000
                        : 3000;
                    if (stableSince !== null && Date.now() - stableSince >= adaptiveMs) {
                        // parity2 050 slice B-01: ordering gate — text that does
                        // not verifiably FOLLOW the latest user turn is stale
                        // history, not the answer. 'unknown' (failed read) and
                        // 'stale' both refuse; 'unverifiable' (no user turn)
                        // passes, as upstream.
                        const ordering = await readTurnOrdering(page);
                        if (ordering === 'stale' || ordering === 'unknown') {
                            transcript.warn(`assistant-ordering-${ordering === 'stale' ? 'stale' : 'unverified'}`);
                            stableSince = null;
                            stableText = undefined;
                            continue;
                        }
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
            if (observerWake) {
                await Promise.race([wait(pollIntervalMs), observerWake]);
                observerWake = null; // one-shot: wake once on settle, then poll normally
            } else {
                await wait(pollIntervalMs);
            }
            if (Date.now() - lastHeartbeatAt >= 30_000) {
                lastHeartbeatAt = Date.now();
                const phase = snap.streaming ? 'streaming' : (stableSince !== null ? 'stabilizing' : 'settling');
                process.stderr.write(`[poll] ${Math.round((Date.now() - pollStartedAt) / 1000)}s — ${phase}\n`);
            }
        } catch (pollErr) {
            // 104.18: a crashed/closed tab is recoverable — surface it as a typed result instead of
            // throwing past the poll boundary, so the caller can relaunch + resume the session.
            if (isPageDeathError(pollErr)) {
                return withResolverTrace(stripUndefined({
                    ok: false,
                    drift: { status: 'tab-crashed', reason: String((pollErr as Error)?.message || pollErr), recoverable: true },
                    usedFallbacks: transcript.usedFallbacks,
                    warnings: [...transcript.warnings, 'tab-crashed-during-poll'],
                }), resolverTrace);
            }
            throw pollErr;
        }
    }

    // parity2 050 slice B-01/B-07: the post-timeout copy path must not admit
    // text the loop's gates refused — ordering applies here too.
    const postLoopOrdering = stableText ? await readTurnOrdering(page) : null;
    // Terminal path: only POSITIVE staleness refuses; unknown/unverifiable fall
    // through to tiers carrying their own gates.
    const postLoopOrderingOk = postLoopOrdering !== 'stale';
    if (options.allowCopyMarkdownFallback && stableText && postLoopOrderingOk) {
        const copyTarget = await resolveOptionalChatGptCopyTarget(page, resolverTrace);
        const copied = await captureCopiedResponseText(page, CHATGPT_COPY_SELECTORS, { copyTarget });
        const copiedText = preferCopiedText(stableText, copied);
        if (copiedText) {
            transcript.fallback('copy-markdown');
            return withResolverTrace({ ok: true, answerText: normalizeAssistantText(copiedText), usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }, resolverTrace);
        }
        transcript.warn(`copy-markdown-fallback-unavailable:${copied.status || 'unknown'}`);
    }

    // 101 #2 3rd-tier recovery (after the opt-in copy fallback): re-read the latest
    // assistant turn once, recovering a final answer the poll loop missed (late DOM settle).
    const recovered = await recoverAssistantResponse(page, {
        baselineAssistantCount: options.minTurnIndex,
        isFinalAnswer: (t) => !isPlaceholderAssistantText(t),
        readStreaming: () => isStreaming(page),
        readFinished: () => isResponseFinished(page, options.minTurnIndex),
    });
    if (recovered?.text && !recovered.streaming) {
        // parity2 050 slice B-01 (recovery gate): the ordering gate applies to
        // recovered text too — agbrowse re-applies it on the recovery path.
        const recoveryOrdering = await readTurnOrdering(page);
        if (recoveryOrdering === 'stale') {
            transcript.warn('assistant-ordering-stale-recovery');
            return withResolverTrace(stripUndefined({ ok: false, usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }), resolverTrace);
        }
        // parity2 050 slice B-07: mere stability (responseStableMs > 0) is NOT
        // completion — the old acceptance admitted half-written answers. Only
        // identity-pinned FINISHED evidence completes; stable-but-unfinished
        // text is reported as a deferred 'polling' outcome so the caller keeps
        // the session alive instead of persisting a truncated answer.
        if (recovered.finished) {
            transcript.fallback('recovery');
            return withResolverTrace({ ok: true, answerText: normalizeAssistantText(recovered.text), usedFallbacks: transcript.usedFallbacks, warnings: transcript.warnings }, resolverTrace);
        }
        transcript.warn('recovery-text-unfinished-deferred');
        return withResolverTrace(stripUndefined({
            ok: false,
            polling: true,
            answerText: normalizeAssistantText(recovered.text),
            usedFallbacks: transcript.usedFallbacks,
            warnings: transcript.warnings,
        }), resolverTrace);
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

/**
 * parity2 050 slice B-03: activity is a VERDICT, not a boolean. An unreadable
 * stop probe reads as 'unknown' — the exact stall-disguised-as-complete case
 * the old catch(() => false) admitted. The probe is composer/main-scoped so
 * dictation/voice/read-aloud/sidebar Stop buttons never count as streaming.
 */
async function probeActivity(page: Page): Promise<ChatGptStopVerdict> {
    const scope = scopeToMainRegion(page);
    return probeStopButton(scope);
}

async function isStreaming(page: Page): Promise<boolean> {
    return (await probeActivity(page)) === 'visible';
}

/**
 * parity2 050 slice B-01: turn-ordering gate. 'unknown' (failed read) is
 * fail-closed — stale historical text must never be admitted as the answer.
 */
async function readTurnOrdering(page: Page): Promise<ChatGptTurnOrderingInPage | 'unknown'> {
    try {
        const verdict = await page.evaluate(readAssistantTurnOrderingInPage, CHATGPT_ASSISTANT_SELECTORS);
        // A malformed result (test double, stripped serialization) is a FAILED
        // observation, not evidence either way.
        return verdict === 'ordered' || verdict === 'stale' || verdict === 'unverifiable' ? verdict : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * parity2 050 slice B-05: identity-pinned completion. The old page-wide
 * .last() scan let a PREVIOUS turn's action bar mark a still-streaming answer
 * finished. The finished-action buttons must live inside the LATEST top-level
 * assistant turn at or past the baseline index.
 */
async function isResponseFinished(page: Page, minTurnIndex = 0): Promise<boolean> {
    try {
        const result = await page.evaluate(
            ({ finishedSelector, minTurnIndex, resolverSource, selectors }: { finishedSelector: string; minTurnIndex: number; resolverSource: string; selectors: string[] }) => {
                const resolver = (0, eval)(`(${resolverSource})`);
                const turns = resolver(selectors);
                for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
                    if (turnIndex < minTurnIndex) break;
                    const turn = turns[turnIndex];
                    return Boolean(turn.querySelector(finishedSelector));
                }
                return false;
            }, {
                finishedSelector: FINISHED_ACTIONS_SELECTOR,
                minTurnIndex,
                resolverSource: resolveTopLevelAssistantTurns.toString(),
                selectors: CHATGPT_ASSISTANT_SELECTORS,
            });
        if (typeof result === 'boolean') return result;
        // Malformed result (test double / stripped serialization): fall through
        // to the legacy visibility scan rather than inventing "not finished".
        return await legacyFinishedScan(page);
    } catch {
        return await legacyFinishedScan(page);
    }
}

async function legacyFinishedScan(page: Page): Promise<boolean> {
    try {
        for (const sel of FINISHED_ACTIONS_SELECTOR.split(', ')) {
            const count = await page.locator(sel).count().catch(() => 0);
            if (count > 0) {
                const visible = await page.locator(sel).last().isVisible().catch(() => false);
                if (visible) return true;
            }
        }
        return false;
    } catch {
        return false;
    }
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

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
