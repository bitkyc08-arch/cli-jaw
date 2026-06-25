import type { Page } from 'playwright-core';
import { updateSessionResult, updateSessionStatus } from './session.js';
import { createChatGptEditorAdapter } from './vendor-editor-contract.js';
import type { WebAiSessionRecord } from './types.js';
import { chooseDeepResearchReportRead, type DeepResearchReportRead } from './chatgpt-deep-research-report.js';

export interface DeepResearchResult {
    ok: boolean;
    sessionId: string;
    conversationUrl: string;
    reportText: string | null;
    sources: string[];
    warnings: string[];
    status: 'complete' | 'timeout' | 'blocked' | 'failed';
}

interface DeepResearchDeps {
    getCdpSession?: () => Promise<{ send(method: string, params: Record<string, unknown>): Promise<unknown>; detach?(): Promise<void> } | null>;
}

const DEEP_RESEARCH_SELECTORS = {
    modeButton: [
        'button[data-testid="deep-research"]',
        'button[aria-label*="Deep research" i]',
        'button:has-text("Deep research")',
    ],
    progressIndicator: [
        '[data-testid="deep-research-progress"]',
        '[role="progressbar"]',
        '.deep-research-status',
        '[class*="research-progress"]',
    ],
    confirmButton: [
        'button[data-testid="deep-research-confirm"]',
        'button:has-text("Start research")',
        'button:has-text("Start")',
        'button:has-text("시작")',
        'button:has-text("Confirm")',
    ],
    blockIndicator: [
        '[data-testid="deep-research-blocked"]',
        'div:has-text("Deep research is not available")',
        'div:has-text("upgrade")',
    ],
};

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
];

async function countAssistants(page: Page): Promise<number> {
    return page.locator(ASSISTANT_SELECTOR).count();
}

async function readLatestAssistant(page: Page): Promise<string> {
    const els = await page.locator(ASSISTANT_SELECTOR).all();
    const last = els[els.length - 1];
    if (!last) return '';
    return last.innerText().catch(() => '');
}

async function isStreaming(page: Page): Promise<boolean> {
    for (const sel of STOP_SELECTORS) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    return false;
}

async function hasProgressIndicator(page: Page): Promise<boolean> {
    for (const sel of DEEP_RESEARCH_SELECTORS.progressIndicator) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    return false;
}

async function isAccountBlocked(page: Page): Promise<boolean> {
    for (const sel of DEEP_RESEARCH_SELECTORS.blockIndicator) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    return false;
}

async function activateDeepResearchMode(page: Page): Promise<boolean> {
    for (const sel of DEEP_RESEARCH_SELECTORS.modeButton) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(1000);
            return true;
        }
    }
    return false;
}

export async function autoConfirmPlan(page: Page, timeoutMs = 70_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const contexts: Array<Page | ReturnType<Page['frames']>[number]> = [page];
        if (typeof page.frames === 'function') {
            contexts.push(...page.frames());
        }

        for (const context of contexts) {
            for (const sel of DEEP_RESEARCH_SELECTORS.confirmButton) {
                const locator = context.locator?.(sel);
                const btn = typeof locator?.first === 'function' ? locator.first() : locator;
                if (!btn || typeof btn.isVisible !== 'function' || typeof btn.click !== 'function') continue;
                if (await btn.isVisible().catch(() => false)) {
                    await btn.click();
                    return true;
                }
            }
        }

        await page.waitForTimeout(250);
    }
    return false;
}

async function extractResearchReport(page: Page): Promise<DeepResearchReportRead | null> {
    const assistantText = (await readLatestAssistant(page)).trim();

    const sources: string[] = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll(
            '[data-message-author-role="assistant"]:last-of-type a[href]',
        ));
        return links
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((h) => h.startsWith('http'));
    }).catch(() => []);

    const targetRead = assistantText ? { text: assistantText, sources, from: 'assistant' } : null;

    // Legacy fallback: a deep-research app iframe on THIS page. Only used when the
    // target read is missing/incomplete (chooseDeepResearchReportRead decides).
    let frameRead: { text: string; sources: string[]; from: string } | null = null;
    const frames = page.frames();
    for (const frame of frames) {
        const frameUrl = frame.url();
        if (frameUrl.includes('deep-research') || frameUrl.includes('research')) {
            const frameText = (await frame.evaluate(() =>
                document.body?.innerText?.trim() || '',
            ).catch(() => '')).trim();
            if (frameText) {
                frameRead = { text: frameText, sources, from: 'frame' };
                break;
            }
        }
    }

    return chooseDeepResearchReportRead(targetRead, frameRead);
}

export async function sendDeepResearch(page: Page, deps: DeepResearchDeps, opts: {
    prompt: string;
    session: WebAiSessionRecord;
    timeoutMs?: number;
    skipModeActivation?: boolean;
}): Promise<DeepResearchResult> {
    const { prompt, session, timeoutMs = 1_200_000, skipModeActivation = false } = opts;
    const warnings: string[] = [];

    const modeActivated = skipModeActivation ? true : await activateDeepResearchMode(page);
    if (!modeActivated) {
        warnings.push('deep-research-mode-button-not-found-using-prompt-prefix');
    }

    if (await isAccountBlocked(page)) {
        updateSessionStatus(session.sessionId, 'error');
        return {
            ok: false,
            sessionId: session.sessionId,
            conversationUrl: page.url(),
            reportText: null,
            sources: [],
            warnings: ['account-blocked-for-deep-research'],
            status: 'blocked',
        };
    }

    const baselineCount = await countAssistants(page);
    // Track whether any Deep Research activity (progress UI / app frame) is ever
    // observed. If not, a final assistant answer is a normal reply, not a report.
    let researchActivityObserved = false;

    const editorOptions = {
        insertText: async (text: string) => {
            const cdp = await deps.getCdpSession?.();
            if (!cdp) throw new Error('CDP session unavailable for Input.insertText');
            try {
                await cdp.send('Input.insertText', { text });
            } finally {
                await cdp.detach?.().catch(() => undefined);
            }
        },
    };
    const adapter = createChatGptEditorAdapter(page, editorOptions);
    await adapter.waitForReady();
    const commitBaseline = await adapter.getCommitBaseline();
    await adapter.insertPrompt(prompt);
    await adapter.submitPrompt();
    await adapter.verifyPromptCommitted(prompt, commitBaseline);

    await autoConfirmPlan(page);

    const blockCheckDeadline = Date.now() + 15_000;
    while (Date.now() < blockCheckDeadline) {
        if (await isAccountBlocked(page)) {
            updateSessionStatus(session.sessionId, 'error');
            return {
                ok: false,
                sessionId: session.sessionId,
                conversationUrl: page.url(),
                reportText: null,
                sources: [],
                warnings: ['account-blocked-after-submit'],
                status: 'blocked',
            };
        }
        const count = await countAssistants(page);
        const progress = await hasProgressIndicator(page);
        if (progress) researchActivityObserved = true;
        if (count > baselineCount || await isStreaming(page) || progress) break;
        await page.waitForTimeout(500);
    }

    const deadline = Date.now() + timeoutMs;
    let stableText = '';
    let stableSince = 0;

    while (Date.now() < deadline) {
        await page.waitForTimeout(2000);

        const streaming = await isStreaming(page);
        const progress = await hasProgressIndicator(page);
        if (progress) researchActivityObserved = true;
        const count = await countAssistants(page);

        if (count > baselineCount && !streaming && !progress) {
            const latest = (await readLatestAssistant(page)).trim();
            if (latest) {
                if (latest === stableText) {
                    if (Date.now() - stableSince >= 5000) {
                        const report = await extractResearchReport(page);
                        // A frame report is definitive proof DR ran.
                        if (report?.from === 'frame') researchActivityObserved = true;

                        if (!researchActivityObserved) {
                            // Stable assistant answer but no research activity ever observed
                            // → a normal reply, not a Deep Research report (catalog 106.1).
                            updateSessionResult({
                                sessionId: session.sessionId,
                                status: 'error',
                                conversationUrl: page.url(),
                            });
                            return {
                                ok: false,
                                sessionId: session.sessionId,
                                conversationUrl: page.url(),
                                reportText: null,
                                sources: [],
                                warnings: [...warnings, 'deep-research-not-started'],
                                status: 'failed',
                            };
                        }

                        if (!report || !report.completed) {
                            // Planning/progress/incomplete text — not a final report; keep waiting.
                            if (!warnings.includes('deep-research-incomplete-report-skipped')) {
                                warnings.push('deep-research-incomplete-report-skipped');
                            }
                            stableText = '';
                            stableSince = 0;
                            continue;
                        }

                        if (report.from === 'frame') warnings.push('report-extracted-from-iframe');

                        updateSessionResult({
                            sessionId: session.sessionId,
                            status: 'complete',
                            answerText: report.text,
                            conversationUrl: page.url(),
                        });
                        // NOTE: report-artifact-save (trySaveReport/appendArtifactRecord) deferred
                        // to Cycle 2 — depends on session-artifacts.ts.

                        return {
                            ok: true,
                            sessionId: session.sessionId,
                            conversationUrl: page.url(),
                            reportText: report.text,
                            sources: report.sources,
                            warnings,
                            status: 'complete',
                        };
                    }
                } else {
                    stableText = latest;
                    stableSince = Date.now();
                }
            }
        } else {
            stableText = '';
            stableSince = 0;
        }
    }

    const finalReport = await extractResearchReport(page);
    // On timeout, only persist a COMPLETED report — never a planning/progress fragment.
    const finalText = finalReport?.completed ? finalReport.text : null;
    updateSessionResult({
        sessionId: session.sessionId,
        status: 'timeout',
        ...(finalText ? { answerText: finalText } : {}),
    });

    return {
        ok: false,
        sessionId: session.sessionId,
        conversationUrl: page.url(),
        reportText: finalText,
        sources: finalReport?.sources ?? [],
        warnings: [...warnings, 'deep-research-timeout'],
        status: 'timeout',
    };
}
