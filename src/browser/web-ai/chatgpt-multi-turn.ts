import type { Page } from 'playwright-core';
import { updateSessionResult } from './session.js';
import { createChatGptEditorAdapter } from './vendor-editor-contract.js';
import type { WebAiSessionRecord, WebAiTurnRecord } from './types.js';

// Re-exported alias preserves the public `TurnResult` name while reusing the
// canonical session turn shape owned by types.ts (avoids a duplicate contract).
export type TurnResult = WebAiTurnRecord;

export interface MultiTurnResult {
    ok: boolean;
    sessionId: string;
    conversationUrl: string;
    turns: TurnResult[];
    finalAnswer: string | null;
    warnings: string[];
    finalStatus: 'complete' | 'partial';
    transcriptMarkdown: string;
}

interface MultiTurnDeps {
    getCdpSession?: () => Promise<{ send(method: string, params: Record<string, unknown>): Promise<unknown>; detach?(): Promise<void> } | null>;
}

async function countAssistants(page: Page): Promise<number> {
    return page.locator('[data-message-author-role="assistant"]').count();
}

async function readLatestAssistant(page: Page): Promise<string> {
    const els = await page.locator('[data-message-author-role="assistant"]').all();
    const last = els[els.length - 1];
    if (!last) return '';
    return last.innerText().catch(() => '');
}

async function isStreaming(page: Page): Promise<boolean> {
    const stop = await page.locator('[data-testid="stop-button"], button[aria-label="Stop generating"]').count();
    return stop > 0;
}

async function submitTurn(page: Page, deps: MultiTurnDeps, opts: { prompt: string }): Promise<void> {
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
    await adapter.insertPrompt(opts.prompt);
    await adapter.submitPrompt();
    await adapter.verifyPromptCommitted(opts.prompt, commitBaseline);
}

async function pollTurn(page: Page, opts: {
    baselineAssistantCount: number;
    timeoutMs?: number;
}): Promise<{ ok: boolean; answerText: string; warnings: string[] }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let stableText = '';
    let stableSince = 0;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));

        const count = await countAssistants(page);
        if (count <= opts.baselineAssistantCount) continue;

        const latest = (await readLatestAssistant(page)).trim();
        const streaming = await isStreaming(page);

        if (latest && !streaming) {
            if (latest === stableText) {
                if (Date.now() - stableSince >= 1500) {
                    return { ok: true, answerText: latest, warnings: [] };
                }
            } else {
                stableText = latest;
                stableSince = Date.now();
            }
        } else if (streaming) {
            stableText = '';
            stableSince = 0;
        }
    }

    return { ok: false, answerText: stableText || '', warnings: ['turn-timeout'] };
}

export async function sendMultiTurn(page: Page, deps: MultiTurnDeps, opts: {
    followUps: string[];
    session: WebAiSessionRecord;
    timeoutPerTurn?: number;
}): Promise<MultiTurnResult> {
    const { followUps, session, timeoutPerTurn = 120_000 } = opts;
    const turns: TurnResult[] = [];
    const allWarnings: string[] = [];
    let finalAnswer: string | null = session.answerText || null;
    // Resume-safe: continue indices from prior turns and merge history on persist,
    // instead of restarting at 0 and dropping earlier turns (catalog 106.2/106.5).
    const existingTurns: WebAiTurnRecord[] = session.turns ?? [];
    let turnIndex = existingTurns.length;

    for (const prompt of followUps) {
        const sentAt = new Date().toISOString();
        const baselineAssistantCount = await countAssistants(page);

        try {
            await submitTurn(page, deps, { prompt });
            const result = await pollTurn(page, { baselineAssistantCount, timeoutMs: timeoutPerTurn });

            const turn: TurnResult = {
                index: turnIndex,
                prompt,
                answer: result.answerText || null,
                status: result.ok ? 'complete' : 'failed',
                warnings: result.warnings,
                sentAt,
                completedAt: new Date().toISOString(),
            };
            turns.push(turn);
            turnIndex++;

            const allTurns = [...existingTurns, ...turns];
            if (result.answerText) finalAnswer = result.answerText;
            updateSessionResult({
                sessionId: session.sessionId,
                status: result.ok ? 'streaming' : 'error',
                turns: allTurns,
                followUpCount: allTurns.length,
                ...(result.answerText ? { answerText: result.answerText } : {}),
            });

            if (!result.ok) {
                allWarnings.push(`turn-${turnIndex - 1}-failed`);
                break;
            }
        } catch (err) {
            turns.push({
                index: turnIndex,
                prompt,
                answer: null,
                status: 'failed',
                warnings: [(err as Error)?.message || 'unknown-error'],
                sentAt,
                completedAt: new Date().toISOString(),
            });
            turnIndex++;

            const allTurns = [...existingTurns, ...turns];
            updateSessionResult({
                sessionId: session.sessionId,
                status: 'error',
                turns: allTurns,
                followUpCount: allTurns.length,
            });
            allWarnings.push(`turn-${turnIndex - 1}-error`);
            break;
        }
    }

    // NOTE: transcript-artifact-save on partial failure (catalog 106.6) is deferred
    // to Cycle 2 — it depends on session-artifacts.ts, which does not exist yet.
    const allTurns = [...existingTurns, ...turns];
    const transcriptMarkdown = renderMultiTurnTranscript(allTurns);
    const ok = turns.length === followUps.length && turns.every((t) => t.status === 'complete');

    updateSessionResult({
        sessionId: session.sessionId,
        status: ok ? 'complete' : 'error',
        conversationUrl: page.url(),
        turns: allTurns,
        followUpCount: allTurns.length,
        ...(finalAnswer ? { answerText: finalAnswer } : {}),
    });

    return {
        ok,
        sessionId: session.sessionId,
        conversationUrl: page.url(),
        turns,
        finalAnswer,
        warnings: allWarnings,
        finalStatus: ok ? 'complete' : 'partial',
        transcriptMarkdown,
    };
}

export function renderMultiTurnTranscript(turns: TurnResult[]): string {
    return turns
        .map((t) => `## Turn ${t.index}\n\n**User:** ${t.prompt}\n\n**Assistant:** ${t.answer || '(no response)'}`)
        .join('\n\n---\n\n');
}
