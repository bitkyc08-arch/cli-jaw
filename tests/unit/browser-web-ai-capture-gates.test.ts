// Cycle 5 (parity2 050): stale-answer admission gates — ordering, tri-state
// activity, identity-pinned completion, deferred recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureAssistantResponse } from '../../src/browser/web-ai/chatgpt-response.ts';

type EvalFn = (...args: never[]) => unknown;

function mkPage(input: {
    assistantTexts: string[];
    ordering?: 'ordered' | 'stale' | 'unverifiable';
    stopVisible?: boolean;
    stopThrows?: boolean;
    finishedInLatestTurn?: boolean;
}): unknown {
    const page: Record<string, unknown> = {
        url: () => 'https://chatgpt.com/c/test',
        waitForTimeout: async () => undefined,
        evaluate: async (fn: EvalFn, _args?: unknown) => {
            const src = String(fn);
            if (src.includes('lastUserTurn') || src.includes('compareDocumentPosition(lastAssistantTurn)')) {
                if (input.ordering === 'stale') return 'stale';
                if (input.ordering === 'unverifiable') return 'unverifiable';
                return 'ordered';
            }
            if (src.includes('finishedSelector')) {
                return Boolean(input.finishedInLatestTurn);
            }
            // readTopLevelAssistantTexts
            return input.assistantTexts;
        },
        locator: (selector: string) => ({
            // scopeToMainRegion returns this locator ('main'); nested locator calls must work.
            locator: (inner: string) => ({
                all: async () => {
                    if (input.stopThrows) throw new Error('cdp lost');
                    if (inner.includes('stop') || inner.includes('Stop')) {
                        return input.stopVisible ? [{ isVisible: async () => true }] : [];
                    }
                    return [];
                },
            }),
            all: async () => {
                if (input.stopThrows) throw new Error('cdp lost');
                if (selector.includes('stop') || selector.includes('Stop')) {
                    return input.stopVisible ? [{ isVisible: async () => true }] : [];
                }
                return [];
            },
            first: () => ({ isVisible: async () => false }),
            count: async () => 0,
            last: () => ({ isVisible: async () => false }),
        }),
    };
    return page;
}

test('C5-ORD-1: stale ordering refuses the answer (poll times out instead of admitting history)', async () => {
    const page = mkPage({ assistantTexts: ['old history answer'], ordering: 'stale', finishedInLatestTurn: true });
    const result = await captureAssistantResponse(page as never, {
        minTurnIndex: 0, timeoutMs: 2_500, pollIntervalMs: 50,
    });
    assert.equal(result.ok, false);
    assert.ok(result.warnings.some(w => w.includes('assistant-ordering-stale')), JSON.stringify(result.warnings));
});

test('C5-ORD-2: ordered text is accepted', async () => {
    const page = mkPage({ assistantTexts: ['a real answer'], ordering: 'ordered', finishedInLatestTurn: true });
    const result = await captureAssistantResponse(page as never, {
        minTurnIndex: 0, timeoutMs: 6_000, pollIntervalMs: 50,
    });
    assert.equal(result.ok, true);
    assert.equal(result.answerText, 'a real answer');
});

test('C5-ACT-1: unreadable stop probe demands the long quiet window (no fast finish)', async () => {
    // stopThrows makes activity 'unknown'; with a 2.5s budget the 5s unknown
    // window cannot elapse, and without finished evidence the recovery tier
    // must DEFER (polling) instead of accepting the half-written text.
    const page = mkPage({ assistantTexts: ['half-written ans'], ordering: 'ordered', stopThrows: true, finishedInLatestTurn: false });
    const result = await captureAssistantResponse(page as never, {
        minTurnIndex: 0, timeoutMs: 2_500, pollIntervalMs: 50,
    });
    assert.equal(result.ok, false);
    assert.equal(result.polling, true, 'stable-but-unfinished recovery defers');
});
