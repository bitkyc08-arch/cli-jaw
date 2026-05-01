import test from 'node:test';
import assert from 'node:assert/strict';
import { contextError, fromCliJawStructuredError, providerError, toErrorJson, WebAiError, wrapError } from '../../src/browser/web-ai/errors.ts';
import { BrowserCapabilityError } from '../../src/browser/primitives.ts';
import { ProviderRuntimeDisabledError } from '../../src/browser/web-ai/provider-adapter.ts';

test('BWAE-001: WebAiError serializes with the canonical 9-field shape', () => {
    const err = new WebAiError({
        errorCode: 'cdp.target-mismatch',
        stage: 'connect',
        vendor: 'chatgpt',
        retryHint: 'tab-switch',
        message: 'wrong tab',
        evidence: { url: 'https://example.com/' },
    });
    const json = err.toJSON();
    assert.equal(json.errorCode, 'cdp.target-mismatch');
    assert.equal(json.vendor, 'chatgpt');
    assert.equal(json.retryHint, 'tab-switch');
    assert.equal(json.mutationAllowed, false);
    assert.deepEqual(json.evidence, { url: 'https://example.com/' });
});

test('BWAE-002: wrapError passes through WebAiError unchanged', () => {
    const original = new WebAiError({ errorCode: 'provider.poll-timeout', stage: 'poll-timeout', retryHint: 'poll-or-resume', message: 'timeout' });
    assert.equal(wrapError(original), original);
});

test('BWAE-003: wrapError maps a plain Error to internal.unhandled', () => {
    const wrapped = wrapError(new Error('boom'));
    assert.equal(wrapped.errorCode, 'internal.unhandled');
    assert.equal(wrapped.stage, 'internal');
    assert.equal(wrapped.retryHint, 'report');
    assert.equal(wrapped.message, 'boom');
});

test('BWAE-004: providerError stamps vendor and contextError leaves it unset', () => {
    const p = providerError('gemini', { errorCode: 'provider.composer-not-visible', stage: 'composer-prereq', retryHint: 're-snapshot', message: 'gone' });
    assert.equal(p.vendor, 'gemini');
    const c = contextError({ errorCode: 'context.over-budget', stage: 'context-preflight', retryHint: 'reduce-files', message: 'big' });
    assert.equal(c.vendor, undefined);
});

test('BWAE-005: toErrorJson omits undefined vendor and preserves selectorsTried', () => {
    const json = toErrorJson({ errorCode: 'provider.composer-not-visible', stage: 'composer-prereq', retryHint: 're-snapshot', message: 'x', selectorsTried: ['.a', '.b'] });
    assert.equal('vendor' in json, false);
    assert.deepEqual(json.selectorsTried, ['.a', '.b']);
});

test('BWAE-006: fromCliJawStructuredError maps WrongTargetError to cdp.target-mismatch with evidence', () => {
    class WrongTargetError extends Error {
        expectedTargetId: string;
        actualTargetId: string;
        constructor(expected: string, actual: string) {
            super(`expected ${expected} got ${actual}`);
            this.name = 'WrongTargetError';
            this.expectedTargetId = expected;
            this.actualTargetId = actual;
        }
    }
    const mapped = fromCliJawStructuredError(new WrongTargetError('tA', 'tB'));
    assert.ok(mapped, 'expected mapped error');
    assert.equal(mapped!.errorCode, 'cdp.target-mismatch');
    assert.deepEqual(mapped!.evidence, { expectedTargetId: 'tA', actualTargetId: 'tB' });
});

test('BWAE-007: fromCliJawStructuredError maps BrowserCapabilityError to capability.unsupported', () => {
    const original = new BrowserCapabilityError('chatgpt-model-selection unsupported', {
        capabilityId: 'chatgpt-model-selection',
        stage: 'capability-preflight',
        mutationAllowed: false,
    });
    const mapped = fromCliJawStructuredError(original);
    assert.ok(mapped);
    assert.equal(mapped!.errorCode, 'capability.unsupported');
    assert.equal(mapped!.stage, 'capability-preflight');
    const ev = mapped!.evidence as { capabilityId?: string };
    assert.equal(ev.capabilityId, 'chatgpt-model-selection');
});

test('BWAE-008: fromCliJawStructuredError maps ProviderRuntimeDisabledError preserving vendor + stage', () => {
    const original = new ProviderRuntimeDisabledError('gemini', 'status');
    const mapped = fromCliJawStructuredError(original);
    assert.ok(mapped);
    assert.equal(mapped!.errorCode, 'provider.runtime-disabled');
    assert.equal(mapped!.vendor, 'gemini');
    assert.equal(mapped!.stage, 'status');
});

test('BWAE-009: fromCliJawStructuredError returns null for unrelated errors', () => {
    assert.equal(fromCliJawStructuredError(new Error('plain')), null);
    assert.equal(fromCliJawStructuredError(null), null);
    assert.equal(fromCliJawStructuredError({ name: 'SomethingElse' }), null);
});
