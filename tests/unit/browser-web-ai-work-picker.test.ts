// Cycle 8b (parity2): Work picker core contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WORK_POWER_MAP,
    normalizeWorkPower,
    normalizeWorkSpeed,
    readWorkPickerState,
    readWorkTaskState,
    assertWorkSessionPollable,
} from '../../src/browser/web-ai/chatgpt-work-picker.ts';

test('W8B-MAP-1: power mapping table 1..6', () => {
    assert.equal(WORK_POWER_MAP.length, 6);
    assert.deepEqual(normalizeWorkPower(1), { power: 1, domValue: 0, compactLabel: '5.6 Terra Light', model: 'GPT-5.6 Terra', effort: 'Light' });
    assert.equal(normalizeWorkPower(6).effort, 'Ultra');
    assert.equal(normalizeWorkPower('4').model, 'GPT-5.6 Sol');
    for (const bad of [0, 7, 1.5, 'banana', null, undefined]) {
        assert.throws(() => normalizeWorkPower(bad), (e: unknown) => (e as { retryHint?: string }).retryHint === 'fix-power', String(bad));
    }
    assert.equal(normalizeWorkSpeed(null), null);
    assert.equal(normalizeWorkSpeed('fast'), 'fast');
    assert.throws(() => normalizeWorkSpeed('turbo'));
});

function pickerPage(input: { domValue?: number | null; valueText?: string | null; simple?: boolean }): unknown {
    return {
        locator: (sel: string) => ({
            first: () => ({
                isVisible: async () => sel.includes('simple-view') ? input.simple !== false : false,
                getAttribute: async (name: string) => {
                    if (name === 'aria-valuenow') return input.domValue != null ? String(input.domValue) : null;
                    if (name === 'aria-valuemin') return '0';
                    if (name === 'aria-valuemax') return '5';
                    if (name === 'aria-valuetext') return input.valueText ?? null;
                    return null;
                },
            }),
            count: async () => sel.includes('[role="slider"]') ? 1 : 0,
        }),
    };
}

test('W8B-STATE-1: picker state derives power/model/effort from the slider', async () => {
    const state = await readWorkPickerState(pickerPage({ domValue: 3, valueText: '5.6 Sol High, 4 of 6.' }) as never);
    assert.equal(state.power, 4);
    assert.equal(state.compactLabel, '5.6 Sol High');
    assert.equal(state.model, 'GPT-5.6 Sol');
    assert.equal(state.effort, 'High');
});

function taskPage(input: { stop: 'visible' | 'absent' | 'throws'; copyVisible?: boolean; answer?: string }): unknown {
    const page: Record<string, unknown> = {
        locator: (sel: string) => ({
            // scopeToMainRegion('main') returns this same shape
            locator: (inner: string) => page['locator'] instanceof Function ? (page['locator'] as (s: string) => unknown)(inner) : null,
            all: async () => {
                if (sel.includes('stop') || sel.includes('Stop')) {
                    if (input.stop === 'throws') throw new Error('unreadable');
                    return input.stop === 'visible' ? [{ isVisible: async () => true }] : [];
                }
                return [];
            },
            first: () => ({
                isVisible: async () => sel.includes('Copy') ? Boolean(input.copyVisible) : false,
                textContent: async () => input.answer ?? null,
            }),
            count: async () => sel.includes('assistant') ? (input.answer ? 1 : 0) : 0,
            last: () => ({ textContent: async () => input.answer ?? null }),
            getByText: () => null,
        }),
        getByText: () => null,
    };
    return page;
}

test('W8B-TASK-1: running when stop visible; unknown fails closed on unreadable probe', async () => {
    const running = await readWorkTaskState(taskPage({ stop: 'visible' }) as never);
    assert.equal(running.status, 'running');
    const unknown = await readWorkTaskState(taskPage({ stop: 'throws', copyVisible: true, answer: 'partial' }) as never);
    assert.equal(unknown.status, 'unknown', 'leftover Copy must not read as finished when the stop probe failed');
});

test('W8B-TASK-2: complete only with copy evidence and readable absent stop', async () => {
    const complete = await readWorkTaskState(taskPage({ stop: 'absent', copyVisible: true, answer: 'the answer' }) as never);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.answerText, 'the answer');
});

test('W8B-GUARD-1: reattach guards reject target mismatch and bare-origin URLs', () => {
    assert.throws(
        () => assertWorkSessionPollable({ sessionId: 's1', targetId: 'T1', conversationUrl: 'https://chatgpt.com/c/x' }, 'T2'),
        (e: unknown) => (e as { errorCode?: string }).errorCode === 'provider.work-reattach-unverified',
    );
    assert.throws(
        () => assertWorkSessionPollable({ sessionId: 's2', targetId: 'T1', conversationUrl: 'https://chatgpt.com/' }, 'T1'),
        (e: unknown) => (e as { retryHint?: string }).retryHint === 'resend-work',
    );
    assert.doesNotThrow(() => assertWorkSessionPollable({ sessionId: 's3', targetId: 'T1', conversationUrl: 'https://chatgpt.com/c/x' }, 'T1'));
});

