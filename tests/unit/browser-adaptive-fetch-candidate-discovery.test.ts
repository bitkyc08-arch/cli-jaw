import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractCandidateUrlsFromText,
    rankDiscoveredCandidates,
} from '../../src/browser/adaptive-fetch/candidate-discovery.js';

test('candidate discovery extracts focused URLs from search text without executing search', () => {
    const urls = extractCandidateUrlsFromText(`
        Official: https://docs.example.test/guide?utm_source=search.
        Community: https://reddit.com/r/example/comments/1
        Duplicate clean: https://docs.example.test/guide
    `);

    assert.deepEqual(urls, [
        'https://docs.example.test/guide?utm_source=search',
        'https://reddit.com/r/example/comments/1',
        'https://docs.example.test/guide',
    ]);
});

test('candidate discovery ranks, dedupes, and groups public candidate URLs by lane', () => {
    const result = rankDiscoveredCandidates([
        {
            url: 'https://docs.example.test/guide?utm_source=search',
            title: 'Official docs',
            snippet: 'API reference',
        },
        {
            url: 'https://docs.example.test/guide',
            title: 'Duplicate official docs',
        },
        {
            url: 'https://www.reddit.com/r/example/comments/1',
            title: 'User report',
        },
        {
            url: 'https://arxiv.org/abs/2606.00001',
            title: 'Research paper',
        },
        {
            url: 'https://x.com/example/status/1',
            title: 'Realtime update',
        },
        {
            url: 'http://localhost:3000/private',
            title: 'Should be rejected',
        },
    ], {
        officialDomains: ['example.test'],
    });

    assert.equal(result.candidates[0]?.lane, 'official');
    assert.equal(result.candidates[0]?.normalizedUrl, 'https://docs.example.test/guide');
    assert.equal(result.lanes.official.length, 1);
    assert.equal(result.lanes.community.length, 1);
    assert.equal(result.lanes.academic.length, 1);
    assert.equal(result.lanes.realtime.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason || '', /private|localhost|blocked|not allowed/i);
});

test('candidate discovery preserves explicit model-gated lane assignments', () => {
    const result = rankDiscoveredCandidates([
        {
            url: 'https://example.test/blog/post',
            title: 'Blog post with official confirmation',
            lane: 'official',
            source: 'model-gated-lane',
        },
        {
            url: 'https://example.test/blog/post?utm_campaign=x',
            title: 'Duplicate lower quality',
            lane: 'fetch',
        },
    ]);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.lane, 'official');
    assert.equal(result.candidates[0]?.source, 'model-gated-lane');
});
