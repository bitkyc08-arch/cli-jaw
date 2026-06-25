import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
    isIncompleteDeepResearchText,
    chooseDeepResearchReportRead,
} from '../../src/browser/web-ai/chatgpt-deep-research-report.js';

// --- Pure completeness logic (catalog 106.1): distinguish a real report from a
// planning card / progress line / short reply. ---

test('BWAI-DR-001: isIncompleteDeepResearchText flags planning/progress/short, accepts long reports', () => {
    assert.equal(isIncompleteDeepResearchText('Researching the latest data on this topic now...'), true);
    assert.equal(isIncompleteDeepResearchText("Here's my research plan:\n1. foo\n2. bar"), true);
    assert.equal(isIncompleteDeepResearchText('Researched 12 sources'), true);
    assert.equal(isIncompleteDeepResearchText('too short'), true);
    const realReport = `# Findings\n\n${'This is a substantial long-form report paragraph. '.repeat(8)}`;
    assert.equal(isIncompleteDeepResearchText(realReport), false);
    assert.equal(isIncompleteDeepResearchText(undefined), true);
});

test('BWAI-DR-002: chooseDeepResearchReportRead prefers completed target, falls back, flags incomplete', () => {
    const longReport = `# Report\n\n${'Detailed evidence-backed analysis sentence. '.repeat(8)}`;
    // completed target wins
    const a = chooseDeepResearchReportRead({ text: longReport, sources: ['https://x'], from: 'assistant' }, null);
    assert.equal(a?.completed, true);
    assert.equal(a?.from, 'assistant');
    // incomplete target + completed frame → frame wins, completed
    const b = chooseDeepResearchReportRead({ text: 'Researching...', from: 'assistant' }, { text: longReport, from: 'frame' });
    assert.equal(b?.completed, true);
    assert.equal(b?.from, 'frame');
    // both incomplete → longer, completed:false
    const c = chooseDeepResearchReportRead({ text: 'Researching now', from: 'assistant' }, { text: 'Reading sources and gathering', from: 'frame' });
    assert.equal(c?.completed, false);
    // both empty → null
    assert.equal(chooseDeepResearchReportRead(null, null), null);
    assert.equal(chooseDeepResearchReportRead({ text: '' }, { text: '' }), null);
});

// --- Integration regression for the not-started guard (the headline 106.1 bug):
// a stable assistant answer with NO research activity observed must NOT be saved as
// a completed report — it is a normal reply, returned as 'failed'. ---

test('BWAI-DR-003: stable answer without research activity is rejected, not saved as a report', async () => {
    const persistCalls: Array<Record<string, unknown>> = [];
    mock.module('../../src/browser/web-ai/session.js', {
        namedExports: {
            updateSessionResult: (input: Record<string, unknown>) => { persistCalls.push(input); return null; },
            updateSessionStatus: () => null,
        },
    });
    mock.module('../../src/browser/web-ai/vendor-editor-contract.js', {
        namedExports: {
            createChatGptEditorAdapter: () => ({
                waitForReady: async () => {},
                getCommitBaseline: async () => ({}),
                insertPrompt: async () => {},
                submitPrompt: async () => {},
                verifyPromptCommitted: async () => {},
            }),
        },
    });

    const { sendDeepResearch } = await import('../../src/browser/web-ai/chatgpt-deep-research.js');

    const state = { assistantCalls: 0, answer: `A normal long reply with no research activity. ${'filler text. '.repeat(12)}` };
    const fakePage = {
        locator(sel: string) {
            const isAssistant = sel === '[data-message-author-role="assistant"]';
            const isConfirm = /Start|Confirm|시작|deep-research-confirm/.test(sel);
            const visible = async () => isConfirm; // only confirm buttons visible; progress/stop/block never
            return {
                count: async () => {
                    if (!isAssistant) return 0;
                    state.assistantCalls += 1;
                    return state.assistantCalls === 1 ? 0 : 1;
                },
                all: async () => (isAssistant ? [{ innerText: async () => state.answer }] : []),
                first() { return { isVisible: visible, click: async () => {} }; },
                isVisible: visible,
                click: async () => {},
            };
        },
        evaluate: async () => [],
        frames: () => [],
        url: () => 'https://chatgpt.com/c/dr',
        waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, Math.min(ms, 250))); },
    };

    const result = await sendDeepResearch(fakePage as unknown as Page, {}, {
        prompt: 'q', session: { sessionId: 'webai_dr' } as never, skipModeActivation: true,
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.warnings.includes('deep-research-not-started'));
    assert.equal(result.reportText, null);
    // never persisted as a completed report
    assert.equal(persistCalls.some((c) => c.status === 'complete'), false);
});
