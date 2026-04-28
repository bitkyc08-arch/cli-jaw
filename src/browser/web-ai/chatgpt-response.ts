/**
 * PRD32.4 — ChatGPT Answer Polling and Response Capture
 *
 * Captures only the assistant turn that landed *after* a committed baseline.
 * Filters placeholder shells, prompt echo, and "Pro Thinking" stalls. Detects
 * Canvas-opened answer state. Copy-markdown fallback is opt-in only and
 * recorded in `usedFallbacks`.
 */

import type { ResponseCaptureResult } from './provider-adapter.js';

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

export const COPY_MARKDOWN_SELECTORS = [
    'button[data-testid="copy-turn-action-button"]',
    'button[aria-label*="Copy" i]',
];

const PLACEHOLDER_PATTERNS: RegExp[] = [
    /^answer now$/i,
    /^pro thinking/i,
    /^finalizing answer$/i,
    /^thinking…?$/i,
    /^searching the web…?$/i,
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

export async function readAssistantSnapshot(page: any, minTurnIndex: number, promptText = ''): Promise<AssistantSnapshot> {
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
    const streaming = await isStreaming(page);
    const canvasOpened = await isCanvasOpened(page);
    const newTexts = allTexts.slice(minTurnIndex);
    const latestNewText = pickLatestRealAnswer(newTexts, promptText);
    return {
        assistantCount: allTexts.length,
        latestNewText,
        streaming,
        canvasOpened,
    };
}

export async function captureAssistantResponse(page: any, options: CaptureOptions): Promise<ResponseCaptureResult> {
    const usedFallbacks: string[] = [];
    const warnings: string[] = [];
    const stableWindowMs = Math.max(250, options.stableWindowMs ?? 1500);
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    const deadline = Date.now() + Math.max(1000, options.timeoutMs);
    let stableSince: number | null = null;
    let stableText: string | undefined;

    while (Date.now() < deadline) {
        const snap = await readAssistantSnapshot(page, options.minTurnIndex, options.promptText);
        if (snap.canvasOpened) {
            return {
                ok: true,
                canvas: { kind: 'opened', reason: 'ChatGPT routed answer into Canvas' },
                answerText: snap.latestNewText,
                usedFallbacks,
                warnings,
            };
        }
        if (!snap.streaming && snap.latestNewText) {
            if (snap.latestNewText === stableText) {
                if (stableSince !== null && Date.now() - stableSince >= stableWindowMs) {
                    return { ok: true, answerText: snap.latestNewText, usedFallbacks, warnings };
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

    if (options.allowCopyMarkdownFallback) {
        const fallbackText = await tryCopyMarkdownFallback(page);
        if (fallbackText) {
            usedFallbacks.push('copy-markdown');
            return { ok: true, answerText: fallbackText, usedFallbacks, warnings };
        }
        warnings.push('copy-markdown-fallback-unavailable');
    }
    return { ok: false, answerText: stableText, usedFallbacks, warnings };
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

async function isStreaming(page: any): Promise<boolean> {
    for (const selector of STOP_BUTTON_SELECTORS) {
        try {
            if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
        } catch {
            // ignore
        }
    }
    return false;
}

async function isCanvasOpened(page: any): Promise<boolean> {
    for (const selector of CANVAS_SELECTORS) {
        try {
            if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
        } catch {
            // ignore
        }
    }
    return false;
}

async function tryCopyMarkdownFallback(page: any): Promise<string | undefined> {
    for (const selector of COPY_MARKDOWN_SELECTORS) {
        try {
            const buttons = await safeAll(page, selector);
            const last = buttons[buttons.length - 1];
            if (!last || !(await last.isVisible().catch(() => false))) continue;
            await last.click({ trial: false }).catch(() => undefined);
            const clipboard = await page.evaluate?.(async () => {
                try {
                    const nav = navigator as unknown as { clipboard?: { readText: () => Promise<string> } };
                    return (await nav.clipboard?.readText()) ?? '';
                } catch { return ''; }
            });
            if (clipboard && typeof clipboard === 'string') return normalizeAssistantText(clipboard);
        } catch {
            // ignore
        }
    }
    return undefined;
}

async function safeAll(page: any, selector: string): Promise<any[]> {
    try { return await page.locator(selector).all(); }
    catch { return []; }
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
