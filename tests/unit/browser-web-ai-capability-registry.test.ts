import test from 'node:test';
import assert from 'node:assert/strict';
import {
    lookupCapability,
    requireCapabilityOrFailClosed,
    listCapabilities,
    listCapabilitySchemas,
    listFrontendObservedCapabilities,
    validateFreshnessGate,
    isCapabilityEnabled,
} from '../../src/browser/web-ai/capability-registry.js';
import { BrowserCapabilityError } from '../../src/browser/primitives.js';

test('CAP-REG-001: registry contains both chatgpt and gemini vendor entries', () => {
    const all = listCapabilities();
    assert.ok(all.length >= 20, 'registry has at least 20 entries');
    assert.ok(all.some(c => c.vendor === 'chatgpt'));
    assert.ok(all.some(c => c.vendor === 'gemini'));
});

test('CAP-REG-002: lookupCapability returns unknown sentinel for unregistered id', () => {
    const out = lookupCapability('nonexistent-feature-xyz');
    assert.equal(out.status, 'unknown');
});

test('CAP-REG-003: requireCapabilityOrFailClosed throws for unknown capability', () => {
    assert.throws(
        () => requireCapabilityOrFailClosed('nonexistent-feature-xyz'),
        (error: any) => error instanceof BrowserCapabilityError
            && error.capabilityId === 'nonexistent-feature-xyz'
            && /unknown capability/.test(error.message),
    );
});

test('CAP-REG-004: validateFreshnessGate accepts complete record', () => {
    const r = validateFreshnessGate({
        retrievalDate: '2026-04-29',
        vendorDocsSearched: ['https://help.openai.com/'],
        officialSourcesUsed: ['https://chatgpt.com/'],
        visibleUpdatedDates: { 'https://chatgpt.com/': '2026-04-15' },
        featureChangesSincePriorPrd: [],
        contradictionsOrUnstableLimits: [],
        uiAuthoritativeForPlanLimits: true,
        implementationImpact: [],
        testsUpdatedBecauseOfDocs: [],
    });
    assert.equal(r.retrievalDate, '2026-04-29');
});

test('CAP-REG-005: validateFreshnessGate rejects missing officialSources', () => {
    assert.throws(() => validateFreshnessGate({
        retrievalDate: '2026-04-29',
        vendorDocsSearched: [],
        officialSourcesUsed: [],
        visibleUpdatedDates: {},
        featureChangesSincePriorPrd: [],
        contradictionsOrUnstableLimits: [],
        uiAuthoritativeForPlanLimits: true,
        implementationImpact: [],
        testsUpdatedBecauseOfDocs: [],
    }), /at least one official source/);
});

test('CAP-REG-006: isCapabilityEnabled is false for unknown ids (fail closed)', () => {
    assert.equal(isCapabilityEnabled('totally-not-real'), false);
});

test('CAP-REG-007: ChatGPT model selection is provider-specific and observation-backed', () => {
    const rows = listCapabilitySchemas({ vendor: 'chatgpt', family: 'modelSelection' });
    const chatgptModel = rows.find((row) => row.capabilityId === 'chatgpt-model-selection');
    assert.ok(chatgptModel, 'chatgpt model selection schema exists');
    assert.equal(chatgptModel?.frontendStatus, 'implemented');
    assert.equal(chatgptModel?.mutationAllowed, true);
    assert.ok(chatgptModel?.activeStateSignals.includes('aria-checked=true'));
    assert.equal(isCapabilityEnabled('web-ai-model-selection'), false, 'generic shared model selection remains disabled');
});

test('CAP-REG-008: headed-observed frontend tools are schema-ready but remain fail-closed before runtime wiring', () => {
    const webSearch = listCapabilitySchemas({ vendor: 'chatgpt' }).find((row) => row.capabilityId === 'chatgpt-web-search-toggle');
    const image = listCapabilitySchemas({ vendor: 'gemini' }).find((row) => row.capabilityId === 'gemini-image-generation-tool');
    assert.equal(webSearch?.frontendStatus, 'schema-ready');
    assert.equal(webSearch?.mutationAllowed, false);
    assert.equal(image?.frontendStatus, 'schema-ready');
    assert.equal(image?.mutationAllowed, false);
    assert.throws(() => requireCapabilityOrFailClosed('chatgpt-web-search-toggle'), /fail-closed|not enabled|stage=capability-preflight/);
});

test('CAP-REG-009: frontend observed list excludes unannotated legacy rows', () => {
    const observed = listFrontendObservedCapabilities();
    assert.ok(observed.some((entry) => entry.id === 'chatgpt-model-selection'));
    assert.ok(observed.some((entry) => entry.id === 'gemini-deep-think'));
    assert.ok(observed.some((entry) => entry.id === 'chatgpt-deep-research-tool'));
    assert.ok(observed.some((entry) => entry.id === 'gemini-video-generation-tool'));
    assert.ok(!observed.some((entry) => entry.id === 'deep-research'), 'legacy shared product row remains unannotated');
});

test('CAP-REG-010: observed ChatGPT and Gemini tool schemas include active-state signals', () => {
    const rows = listCapabilitySchemas({ frontendStatus: 'schema-ready' });
    const chatgptImage = rows.find((row) => row.capabilityId === 'chatgpt-image-generation-tool');
    const geminiModel = rows.find((row) => row.capabilityId === 'gemini-model-picker');
    assert.ok(chatgptImage?.activeStateSignals.some((signal) => signal.includes('Image')));
    assert.ok(geminiModel?.activationPath.includes('click Open mode picker'));
    assert.equal(isCapabilityEnabled('gemini-video-generation-tool'), false);
});
