import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BrowserCapabilityError,
    ActionTranscript,
    findVisibleCandidate,
    captureTextBaseline,
    waitForStableTextAfterBaseline,
    isLocatorVisible,
} from '../../src/browser/web-ai/browser-primitives.js';

function fakeLocator(input: { visible?: boolean; text?: string; count?: number } = {}) {
    return {
        waitFor: async ({ state }: any) => {
            if (state === 'visible' && !input.visible) throw new Error('not visible');
        },
        boundingBox: async () => (input.visible ? { width: 10, height: 10 } : null),
        evaluate: async () => input.visible,
        innerText: async () => input.text || '',
        count: async () => input.count ?? 1,
        nth: () => fakeLocator(input),
        first: () => fakeLocator(input),
        all: async () => [fakeLocator(input)],
    };
}

function fakePage(locators: Record<string, any>) {
    return {
        locator: (selector: string) => locators[selector] || fakeLocator({ count: 0 }),
        waitForTimeout: async () => {},
        evaluate: async (fn: any, arg: any) => {
            if (typeof fn === 'function') return fn(arg);
            return [];
        },
    };
}

test('BPRIM-001: BrowserCapabilityError carries metadata', () => {
    const err = new BrowserCapabilityError('blocked', {
        capabilityId: 'test-cap',
        stage: 'capability-preflight',
    });
    assert.equal(err.name, 'BrowserCapabilityError');
    assert.equal(err.capabilityId, 'test-cap');
    assert.equal(err.stage, 'capability-preflight');
    assert.equal(err.mutationAllowed, false);
});

test('BPRIM-002: ActionTranscript records warnings and fallbacks', () => {
    const t = new ActionTranscript();
    t.warn('slow');
    t.fallback('dom-eval');
    const json = t.toJSON();
    assert.deepEqual(json.warnings, ['slow']);
    assert.deepEqual(json.usedFallbacks, ['dom-eval']);
    json.warnings.push('mutated');
    assert.deepEqual(t.toJSON().warnings, ['slow']);
});

test('BPRIM-003: findVisibleCandidate returns visible locator', async () => {
    const page = fakePage({
        '.a': fakeLocator({ visible: false, count: 1 }),
        '.b': fakeLocator({ visible: true, count: 1 }),
    });
    const result = await findVisibleCandidate(page as any, ['.a', '.b']);
    assert.ok(result);
    assert.equal(result?.selector, '.b');
    assert.equal(result?.visible, true);
});

test('BPRIM-004: findVisibleCandidate returns null when nothing visible', async () => {
    const page = fakePage({
        '.a': fakeLocator({ visible: false, count: 1 }),
    });
    const result = await findVisibleCandidate(page as any, ['.a']);
    assert.equal(result, null);
});

test('BPRIM-005: findVisibleCandidate falls back to first candidate when allowed', async () => {
    const page = fakePage({
        '.a': fakeLocator({ visible: false, count: 1 }),
    });
    const result = await findVisibleCandidate(page as any, ['.a'], { allowFirstCandidateFallback: true });
    assert.ok(result);
    assert.equal(result?.visible, false);
});

test('BPRIM-006: captureTextBaseline reads texts and hashes', async () => {
    const page = fakePage({
        '.text': fakeLocator({ text: 'hello', count: 1 }),
    });
    const baseline = await captureTextBaseline(page as any, ['.text']);
    assert.equal(baseline.count, 1);
    assert.ok(baseline.textHash);
    assert.ok(baseline.capturedAt);
});

test('BPRIM-007: waitForStableTextAfterBaseline detects stable text', async () => {
    let callCount = 0;
    const page = {
        locator: () => ({
            all: async () => [],
        }),
        waitForTimeout: async () => {},
        evaluate: async () => {
            callCount += 1;
            return callCount >= 2 ? ['baseline', 'stable'] : ['baseline'];
        },
    };
    const baseline = await captureTextBaseline(page as any, ['.msg']);
    const result = await waitForStableTextAfterBaseline(
        page as any,
        ['.msg'],
        baseline,
        { timeoutMs: 500, stableWindowMs: 50, pollIntervalMs: 25 },
    );
    assert.ok(result.ok);
    assert.equal(result.latestText, 'stable');
});

test('BPRIM-008: isLocatorVisible checks bounding box and evaluate', async () => {
    const visibleLocator = fakeLocator({ visible: true });
    assert.equal(await isLocatorVisible(visibleLocator), true);

    const hiddenLocator = fakeLocator({ visible: false });
    assert.equal(await isLocatorVisible(hiddenLocator), false);
});
