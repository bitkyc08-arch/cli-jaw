import type { Page } from 'playwright-core';
import { updateSessionResult, appendSessionArtifact } from './session.js';
import { trySaveTranscript } from './session-artifacts.js';
import { createChatGptEditorAdapter } from './vendor-editor-contract.js';
import { withPollDeadline, type PollDeadlineToken } from './poll-deadline.js';
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

/**
 * parity2 070 slice D-02: tri-state probe — an unreadable count is 'unknown',
 * which BLOCKS completion instead of reading as "not streaming".
 */
async function probeStopState(page: Page): Promise<'visible' | 'absent' | 'unknown'> {
    try {
        const stop = await page.locator('[data-testid="stop-button"], button[aria-label="Stop generating"]').count();
        return stop > 0 ? 'visible' : 'absent';
    } catch {
        return 'unknown';
    }
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
    deadlineToken?: PollDeadlineToken;
}): Promise<{ ok: boolean; answerText: string; warnings: string[] }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let stableText = '';
    let stableSince = 0;

    while (Date.now() < deadline && !opts.deadlineToken?.expired) {
        // parity2 070 slice D-02: cap the tick by the remaining budget.
        await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));

        const count = await countAssistants(page);
        if (count <= opts.baselineAssistantCount) continue;

        const latest = (await readLatestAssistant(page)).trim();
        const stopState = await probeStopState(page);

        if (latest && stopState === 'absent') {
            if (latest === stableText) {
                if (Date.now() - stableSince >= 1500) {
                    return { ok: true, answerText: latest, warnings: [] };
                }
            } else {
                stableText = latest;
                stableSince = Date.now();
            }
        } else if (stopState !== 'absent') {
            // visible OR unknown both reset stability: an unreadable probe must
            // not let a half-written answer pass as stable.
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
    /** Test/ops override for the outer sequence bound; defaults to a floor of 60s or turns*budget+30s. */
    outerBudgetMs?: number;
}): Promise<MultiTurnResult> {
    const { followUps, session, timeoutPerTurn = 120_000 } = opts;
    // parity2 070 slice D-01: the WHOLE follow-up sequence runs under a hard
    // outer deadline — per-turn budgets alone let a stalled probe hold the
    // caller indefinitely, and a losing run could still write to the session.
    const outerBudgetMs = opts.outerBudgetMs ?? Math.max(60_000, followUps.length * timeoutPerTurn + 30_000);
    return withPollDeadline<MultiTurnResult>(
        (_hardDeadline, token) => sendMultiTurnInner(page, deps, { ...opts, timeoutPerTurn }, token),
        {
            timeoutMs: outerBudgetMs,
            onExpired: () => ({
                ok: false,
                sessionId: session.sessionId,
                conversationUrl: page.url?.() || session.conversationUrl || '',
                turns: [],
                finalAnswer: null,
                warnings: ['multi-turn-deadline-expired'],
                finalStatus: 'partial',
                transcriptMarkdown: '',
            }),
        },
    );
}

async function sendMultiTurnInner(page: Page, deps: MultiTurnDeps, opts: {
    followUps: string[];
    session: WebAiSessionRecord;
    timeoutPerTurn?: number;
}, deadlineToken: PollDeadlineToken): Promise<MultiTurnResult> {
    const { followUps, session, timeoutPerTurn = 120_000 } = opts;
    const turns: TurnResult[] = [];
    const allWarnings: string[] = [];
    let finalAnswer: string | null = session.answerText || null;
    // Resume-safe: continue indices from prior turns and merge history on persist,
    // instead of restarting at 0 and dropping earlier turns (catalog 106.2/106.5).
    const existingTurns: WebAiTurnRecord[] = session.turns ?? [];
    let turnIndex = existingTurns.length;

    for (const prompt of followUps) {
        // parity2 070 slice D-01: a losing run must not start another turn (or
        // write) after the caller has been answered.
        if (deadlineToken.expired) {
            allWarnings.push('multi-turn-deadline-expired');
            break;
        }
        const sentAt = new Date().toISOString();
        const baselineAssistantCount = await countAssistants(page);

        try {
            await submitTurn(page, deps, { prompt });
            const result = await pollTurn(page, { baselineAssistantCount, timeoutMs: timeoutPerTurn, deadlineToken });

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
            if (!deadlineToken.expired) updateSessionResult({
                sessionId: session.sessionId,
                status: result.ok ? 'streaming' : 'partial',
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
            if (!deadlineToken.expired) updateSessionResult({
                sessionId: session.sessionId,
                status: 'partial',
                turns: allTurns,
                followUpCount: allTurns.length,
            });
            allWarnings.push(`turn-${turnIndex - 1}-error`);
            break;
        }
    }

    const allTurns = [...existingTurns, ...turns];
    const transcriptMarkdown = renderMultiTurnTranscript(allTurns);
    const ok = turns.length === followUps.length && turns.every((t) => t.status === 'complete');

    // On partial failure, persist the merged transcript as a session artifact (catalog 106.6).
    if (!ok && transcriptMarkdown) {
        const saved = trySaveTranscript(session.sessionId, transcriptMarkdown);
        if (saved.ok) appendSessionArtifact(session.sessionId, saved.descriptor);
        else allWarnings.push(`artifact-save-failed:${saved.stage}:${saved.error}`);
    }

    if (!deadlineToken.expired) updateSessionResult({
        sessionId: session.sessionId,
        // parity2 070 slice C-04: a partial multi-turn is resumable — 'error'
        // destroyed that signal.
        status: ok ? 'complete' : 'partial',
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
