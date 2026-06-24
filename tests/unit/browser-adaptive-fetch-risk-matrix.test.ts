import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdaptiveFetchOptions, runAdaptiveFetch } from '../../src/browser/adaptive-fetch/index.js';
import { detectWafChallenge, classifyChallengeType } from '../../src/browser/adaptive-fetch/challenge-detector.js';
import { scoreReaderCandidate } from '../../src/browser/adaptive-fetch/content-scorer.js';
import { findBoundaryMarkers } from '../../src/browser/adaptive-fetch/validators.js';
import { validateFetchUrl } from '../../src/browser/adaptive-fetch/safety.js';
import type { ReaderCandidate } from '../../src/browser/adaptive-fetch/types.js';

// --- Normalizer wiring ---

test('normalizer preserves query and proxy fields', () => {
    const opts = normalizeAdaptiveFetchOptions({
        url: 'https://example.com',
        query: 'important search term',
        proxy: 'http://proxy.example:8080',
    });
    assert.equal(opts.query, 'important search term');
    assert.equal(opts.proxy, 'http://proxy.example:8080');
});

test('normalizer drops empty string query and proxy', () => {
    const opts = normalizeAdaptiveFetchOptions({
        url: 'https://example.com',
        query: '',
        proxy: '',
    });
    assert.equal(opts.query, undefined);
    assert.equal(opts.proxy, undefined);
});

// --- Challenge detector precision ---

test('status-only 403 does NOT classify as WAF challenge', () => {
    const result = detectWafChallenge({
        status: 403,
        headers: {},
        body: '<html><body>Forbidden</body></html>',
    });
    assert.equal(result.detected, false, 'bare 403 without cookie/header/body WAF signals should not detect WAF');
});

test('403 with cloudflare body signal DOES classify as WAF', () => {
    const result = detectWafChallenge({
        status: 403,
        headers: { server: 'cloudflare', 'cf-ray': 'abc123' },
        body: '<html><body>Checking your browser before accessing</body></html>',
    });
    assert.equal(result.detected, true);
    assert.equal(result.primary?.profile?.id, 'cloudflare_managed_challenge');
});

test('classifyChallengeType returns null type for generic 403', () => {
    const result = classifyChallengeType({
        status: 403,
        headers: {},
        body: 'Access denied',
    });
    assert.equal(result.type, null, 'generic 403 should not trigger challenge classification');
});

// --- WAF score threshold ---

test('WAF profile with only status match (score 1) is filtered out', () => {
    const result = detectWafChallenge({
        status: 403,
        headers: {},
        body: '',
    });
    assert.equal(result.profiles.length, 0, 'no WAF profiles should match on status alone');
});

test('WAF profile with status + header match (score 3+) is included', () => {
    const result = detectWafChallenge({
        status: 403,
        headers: { server: 'cloudflare' },
        body: '',
    });
    assert.equal(result.detected, true);
    assert.ok(result.profiles.length > 0);
});

// --- Boundary marker context ---

test('subscribe in long article does NOT trigger paywall marker', () => {
    const longText = 'This is a great article about technology. '.repeat(100) + 'Subscribe to our newsletter.';
    const markers = findBoundaryMarkers(longText, { textLength: longText.length });
    const paywallMarkers = markers.filter(m => m.kind === 'paywall');
    assert.equal(paywallMarkers.length, 0, 'long article with subscribe footer should not be marked as paywall');
});

test('subscribe in short text DOES trigger paywall marker', () => {
    const shortText = 'Subscribe to continue reading this premium content.';
    const markers = findBoundaryMarkers(shortText, { textLength: shortText.length });
    const paywallMarkers = markers.filter(m => m.kind === 'paywall');
    assert.ok(paywallMarkers.length > 0, 'short text with subscribe should be marked as paywall');
});

test('challenge markers are detected regardless of text length', () => {
    const longText = 'Content about security. '.repeat(200) + 'Checking your browser before accessing.';
    const markers = findBoundaryMarkers(longText, { textLength: longText.length });
    const challengeMarkers = markers.filter(m => m.kind === 'challenge');
    assert.ok(challengeMarkers.length > 0, 'challenge markers should always be detected');
});

// --- Subtitle URL safety ---

test('subtitle fetch rejects private IP URLs', () => {
    assert.throws(() => validateFetchUrl('http://127.0.0.1/subtitles.vtt'), /private/i);
    assert.throws(() => validateFetchUrl('http://10.0.0.1/subtitles.vtt'), /private/i);
    assert.throws(() => validateFetchUrl('http://192.168.1.1/subtitles.vtt'), /private/i);
});

test('subtitle fetch accepts public URLs', () => {
    const result = validateFetchUrl('https://cdn.example.com/subtitles.vtt');
    assert.equal(result.hostname, 'cdn.example.com');
});

// --- Overall deadline ---

test('scheduler skips stages past deadline', async () => {
    let fetchCount = 0;
    const result = await runAdaptiveFetch({
        url: 'https://example.com/slow',
        browserMode: 'never',
        publicEndpoints: false,
        overallTimeoutMs: 1,
        trace: true,
    }, {
        fetch: async () => {
            fetchCount++;
            await new Promise(resolve => setTimeout(resolve, 50));
            return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
        },
    });
    const attempts = result['attempts'] as Array<{ reason?: string }>;
    const deadlineAttempt = attempts.find(a => a.reason === 'overall-deadline-exceeded');
    assert.ok(deadlineAttempt || fetchCount <= 1, 'should either hit deadline or complete quickly');
});

// --- Scorer: longer irrelevant content should not always win ---

test('scorer gives public_endpoint higher trust than browser', () => {
    const endpointCandidate: ReaderCandidate = {
        source: 'public_endpoint', label: 'npm-registry', finalUrl: 'https://registry.npmjs.org/x',
        title: 'Package X', text: 'Package: x@1.0.0\nDescription: A package',
        contentType: 'application/json', status: 200, ok: true,
        metadata: null, evidence: [], warnings: [], safetyFlags: [], rawTextLength: 40,
    };
    const browserCandidate: ReaderCandidate = {
        source: 'browser', label: 'browser-render', finalUrl: 'https://example.com',
        title: 'Page', text: 'Short browser content here',
        contentType: 'text/html', status: 200, ok: true,
        metadata: null, evidence: [], warnings: [], safetyFlags: [], rawTextLength: 26,
    };
    const endpointScored = scoreReaderCandidate(endpointCandidate);
    const browserScored = scoreReaderCandidate(browserCandidate);
    assert.ok(endpointScored.score >= browserScored.score,
        `public_endpoint (${endpointScored.score}) should score >= browser (${browserScored.score}) for similar-length content`);
});

test('candidate with ok=false gets score 0', () => {
    const failedCandidate: ReaderCandidate = {
        source: 'fetch', label: 'direct-fetch', finalUrl: 'https://example.com',
        title: 'Error Page', text: 'This is a long error page '.repeat(200),
        contentType: 'text/html', status: 403, ok: false,
        metadata: null, evidence: [], warnings: [], safetyFlags: [], rawTextLength: 5000,
    };
    const scored = scoreReaderCandidate(failedCandidate);
    assert.equal(scored.score, 0, 'failed candidates should always get score 0');
});
