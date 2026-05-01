/**
 * PRD32.5 — Web-AI Diagnostics and Failure Artifacts
 *
 * Redacted, bounded diagnostics envelope for every web-ai failure. Prompt text
 * is never included. Screenshots are opt-in. All fallback usage is recorded in
 * `usedFallbacks` so silent fallback is impossible.
 */

import { captureBrowserDiagnostics } from '../primitives.js';

export type WebAiFailureStage =
    | 'status'
    | 'composer-focus'
    | 'composer-insert'
    | 'composer-verify'
    | 'send-click'
    | 'prompt-commit'
    | 'poll-timeout'
    | 'attachment-preflight'
    | 'attachment-upload'
    | 'capability-preflight'
    | 'provider-select-model'
    | 'provider-select-mode'
    | 'session-reattach'
    | 'unknown';

export interface WebAiDiagnostics {
    stage: WebAiFailureStage;
    url?: string;
    title?: string;
    selectorCounts: Record<string, number>;
    visibleComposerCandidates: number;
    sendButtonStates: Array<'enabled' | 'disabled' | 'absent'>;
    conversationTurnCount: number;
    assistantTurnCount: number;
    stopVisible: boolean;
    uploadSignals: Record<string, number | boolean>;
    promptLengthOnly?: number;
    usedFallbacks: string[];
    artifactRefs: string[];
    warnings: string[];
}

export interface DiagnosticsCaptureOptions {
    stage: WebAiFailureStage;
    page?: any;
    promptLength?: number;
    usedFallbacks?: string[];
    /** Opt-in only. */
    enableScreenshot?: boolean;
    /** Cap for any free-form diagnostic text. */
    maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1024;

const KNOWN_STAGES: ReadonlySet<WebAiFailureStage> = new Set([
    'status',
    'composer-focus',
    'composer-insert',
    'composer-verify',
    'send-click',
    'prompt-commit',
    'poll-timeout',
    'attachment-preflight',
    'attachment-upload',
    'capability-preflight',
    'provider-select-model',
    'provider-select-mode',
    'session-reattach',
    'unknown',
]);

export function normalizeFailureStage(stage: unknown): WebAiFailureStage {
    if (typeof stage === 'string' && KNOWN_STAGES.has(stage as WebAiFailureStage)) {
        return stage as WebAiFailureStage;
    }
    return 'unknown';
}

const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
    // Bearer/token-ish strings
    { pattern: /bearer\s+[A-Za-z0-9._\-]+/gi, replacement: 'bearer [redacted]' },
    { pattern: /sk-[A-Za-z0-9_\-]{8,}/g, replacement: 'sk-[redacted]' },
    { pattern: /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '[email redacted]' },
    // 32+ char hex/base64 blobs likely to be cookies/tokens
    { pattern: /\b[A-Fa-f0-9]{32,}\b/g, replacement: '[hex redacted]' },
];

export interface RedactionOptions {
    maxChars?: number;
    /** When true, also strip everything between fenced code blocks. */
    stripCodeFences?: boolean;
}

export function redactDiagnosticText(value: unknown, options: RedactionOptions = {}): string {
    let text = value === undefined || value === null ? '' : String(value);
    if (options.stripCodeFences) {
        text = text.replace(/```[\s\S]*?```/g, '[code redacted]');
    }
    for (const rule of REDACT_PATTERNS) {
        text = text.replace(rule.pattern, rule.replacement);
    }
    const cap = Math.max(64, options.maxChars ?? DEFAULT_MAX_CHARS);
    if (text.length > cap) text = text.slice(0, cap) + '…[truncated]';
    return text;
}

export function emptyDiagnostics(stage: WebAiFailureStage = 'unknown'): WebAiDiagnostics {
    return {
        stage: normalizeFailureStage(stage),
        selectorCounts: {},
        visibleComposerCandidates: 0,
        sendButtonStates: [],
        conversationTurnCount: 0,
        assistantTurnCount: 0,
        stopVisible: false,
        uploadSignals: {},
        usedFallbacks: [],
        artifactRefs: [],
        warnings: [],
    };
}

const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    '.ProseMirror',
    '[contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
];
const STOP_BUTTON_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
];
const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];

/**
 * Capture diagnostics for the current page. Best-effort — never throws; any
 * failure is recorded as a warning so the diagnostics envelope itself does not
 * become a new failure source.
 */
export async function captureWebAiDiagnostics(
    options: DiagnosticsCaptureOptions,
): Promise<WebAiDiagnostics> {
    const out = emptyDiagnostics(options.stage);
    out.usedFallbacks = [...(options.usedFallbacks || [])];
    if (typeof options.promptLength === 'number') {
        out.promptLengthOnly = Math.max(0, Math.floor(options.promptLength));
    }
    const page = options.page;
    const browserDiagnostics = await captureBrowserDiagnostics({
        page,
        selectors: [...COMPOSER_SELECTORS, ...SEND_BUTTON_SELECTORS, ...STOP_BUTTON_SELECTORS, ASSISTANT_SELECTORS.join(','), 'article[data-testid^="conversation-turn"]'],
        visibleSelectors: [...COMPOSER_SELECTORS, ...STOP_BUTTON_SELECTORS],
        redactText: redactDiagnosticText,
    });
    out.warnings.push(...browserDiagnostics.warnings);
    out.url = browserDiagnostics.url;
    out.title = browserDiagnostics.title;
    if (!page) return out;
    for (const selector of COMPOSER_SELECTORS) {
        out.selectorCounts[selector] = browserDiagnostics.selectorCounts[selector] ?? 0;
    }
    out.visibleComposerCandidates = COMPOSER_SELECTORS
        .map((selector) => browserDiagnostics.visibleCounts[selector] ?? 0)
        .reduce((sum, count) => sum + count, 0);
    for (const selector of SEND_BUTTON_SELECTORS) {
        out.sendButtonStates.push(await readButtonState(page, selector));
    }
    out.stopVisible = STOP_BUTTON_SELECTORS.some((selector) => (browserDiagnostics.visibleCounts[selector] ?? 0) > 0);
    out.assistantTurnCount = browserDiagnostics.selectorCounts[ASSISTANT_SELECTORS.join(',')] ?? 0;
    out.conversationTurnCount = browserDiagnostics.selectorCounts['article[data-testid^="conversation-turn"]'] ?? 0;
    out.uploadSignals = {
        composerFileInputs: await safeCount(page, 'input[type="file"]'),
        chipNodes: await safeCount(page, '[data-testid*="attachment" i], [aria-label*="attachment" i]'),
        progressNodes: await safeCount(page, '[role="progressbar"]'),
    };
    return out;
}

async function safeCount(page: any, selector: string): Promise<number> {
    try {
        return await page.locator(selector).count();
    } catch {
        return 0;
    }
}

async function safeVisibleCount(page: any, selectors: string[]): Promise<number> {
    let total = 0;
    for (const selector of selectors) {
        try {
            const locators = await page.locator(selector).all();
            for (const loc of locators) {
                if (await loc.isVisible().catch(() => false)) total += 1;
            }
        } catch {
            // ignore
        }
    }
    return total;
}

async function readButtonState(page: any, selector: string): Promise<'enabled' | 'disabled' | 'absent'> {
    try {
        const loc = page.locator(selector).first();
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) return 'absent';
        const disabled = await loc.isDisabled().catch(() => false);
        return disabled ? 'disabled' : 'enabled';
    } catch {
        return 'absent';
    }
}

export interface WebAiErrorEnvelope {
    ok: false;
    error: string;
    stage: WebAiFailureStage;
    diagnostics?: WebAiDiagnostics;
}

export function toWebAiErrorEnvelope(
    error: unknown,
    fallbackStage: WebAiFailureStage = 'unknown',
    diagnostics?: WebAiDiagnostics,
): WebAiErrorEnvelope {
    // Phase 2 PR2 mirror: if the error is a typed WebAiError, prefer its
    // serializer so the HTTP and CLI layers agree on errorCode/retryHint
    // semantics. Legacy fallback shape stays for non-typed throws during the
    // transition window.
    const typed = (error && typeof error === 'object' && (error as { name?: string }).name === 'WebAiError' && typeof (error as { toJSON?: unknown }).toJSON === 'function')
        ? ((error as { toJSON: () => Record<string, unknown> }).toJSON())
        : null;
    if (typed) {
        const message = redactDiagnosticText(String(typed.message ?? ''), { maxChars: 512 });
        const stage = normalizeFailureStage(String(typed.stage ?? diagnostics?.stage ?? fallbackStage));
        return diagnostics
            ? { ok: false, error: message, stage, diagnostics }
            : { ok: false, error: message, stage };
    }
    const message = redactDiagnosticText((error as Error)?.message ?? error, { maxChars: 512 });
    const stage = normalizeFailureStage((error as { stage?: string })?.stage ?? diagnostics?.stage ?? fallbackStage);
    return diagnostics
        ? { ok: false, error: message, stage, diagnostics }
        : { ok: false, error: message, stage };
}
