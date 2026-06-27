import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeChatGptFileDownloadUrl,
    normalizeChatGptSandboxUrl,
    sanitizeDownloadFilename,
    filenameFromContentDisposition,
    resolveDownloadFilename,
    dedupeDownloadCandidates,
    saveAssistantDownloadableFiles,
} from '../../src/browser/web-ai/chatgpt-files.js';

// --- Trust boundary (catalog 101 #1): only known ChatGPT file endpoints on the
// ChatGPT origin are accepted; everything else is rejected. ---
test('BWAI-FILES-001: URL allowlist accepts known endpoints, rejects unsafe ones', () => {
    // accepted
    assert.equal(
        normalizeChatGptFileDownloadUrl('https://chatgpt.com/backend-api/files/abc_123/download'),
        'https://chatgpt.com/backend-api/files/abc_123/download',
    );
    assert.ok(normalizeChatGptFileDownloadUrl('/backend-api/files/x-1/content')?.startsWith('https://chatgpt.com/'));
    assert.ok(normalizeChatGptFileDownloadUrl('https://chat.openai.com/backend-api/files/x/download'));
    assert.ok(normalizeChatGptFileDownloadUrl('/backend-api/estuary/content?id=file_abc123'));

    // rejected
    assert.equal(normalizeChatGptFileDownloadUrl('https://evil.com/backend-api/files/x/download'), null, 'foreign host');
    assert.equal(normalizeChatGptFileDownloadUrl('http://chatgpt.com/backend-api/files/x/download'), null, 'non-https');
    assert.equal(normalizeChatGptFileDownloadUrl('https://chatgpt.com:8443/backend-api/files/x/download'), null, 'port');
    assert.equal(normalizeChatGptFileDownloadUrl('https://chatgpt.com/backend-api/files/../../etc/passwd'), null, 'traversal');
    assert.equal(normalizeChatGptFileDownloadUrl('https://chatgpt.com/whatever'), null, 'unknown path');
    assert.equal(normalizeChatGptFileDownloadUrl('https://chatgpt.com/backend-api/estuary/content?id=evil'), null, 'bad estuary id');
    assert.equal(normalizeChatGptFileDownloadUrl('javascript:alert(1)'), null, 'scheme');
    assert.equal(normalizeChatGptFileDownloadUrl(''), null);
    assert.equal(normalizeChatGptFileDownloadUrl(null), null);
});

test('BWAI-FILES-002: sandbox URL normalization is /mnt/data-scoped and traversal-safe', () => {
    assert.equal(
        normalizeChatGptSandboxUrl('sandbox:/mnt/data/report.csv'),
        'https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Freport.csv',
    );
    assert.equal(normalizeChatGptSandboxUrl('sandbox:/mnt/data/../../etc/passwd'), null, 'traversal');
    assert.equal(normalizeChatGptSandboxUrl('sandbox:/etc/passwd'), null, 'outside /mnt/data');
    assert.equal(normalizeChatGptSandboxUrl('/mnt/data/x'), null, 'not a sandbox: ref');
    // routed through the generic normalizer too
    assert.ok(normalizeChatGptFileDownloadUrl('sandbox:/mnt/data/out.zip')?.includes('/backend-api/sandbox/download'));
});

test('BWAI-FILES-003: filename sanitization + Content-Disposition + resolution order', () => {
    assert.equal(sanitizeDownloadFilename('a/b/c.csv'), 'c.csv');
    assert.equal(sanitizeDownloadFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeDownloadFilename('<bad>.txt'), '_bad_.txt');
    assert.equal(sanitizeDownloadFilename('.'), '');

    assert.equal(filenameFromContentDisposition('attachment; filename="report.csv"'), 'report.csv');
    assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
    assert.equal(filenameFromContentDisposition('attachment'), null);

    // CD > download attr > URL basename > fallback
    assert.equal(resolveDownloadFilename({ contentDisposition: 'attachment; filename="cd.csv"', downloadAttr: 'attr.csv' }), 'cd.csv');
    assert.equal(resolveDownloadFilename({ downloadAttr: 'attr.csv' }), 'attr.csv');
    assert.equal(resolveDownloadFilename({ sourceUrl: 'https://chatgpt.com/backend-api/sandbox/download?path=/mnt/data/x.zip' }), 'x.zip');
    assert.equal(resolveDownloadFilename({ sourceUrl: 'https://chatgpt.com/backend-api/files/abc/download', index: 2 }), 'chatgpt-file-3');
});

test('BWAI-FILES-004: dedupe drops non-allowlisted hrefs and collapses duplicates', () => {
    const out = dedupeDownloadCandidates([
        { href: 'https://chatgpt.com/backend-api/files/a/download', download: 'a.csv' },
        { href: 'https://chatgpt.com/backend-api/files/a/download' }, // dup
        { href: 'https://evil.com/x' }, // dropped
        { href: '/backend-api/files/b/content' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.download, 'a.csv');
});

// --- Sequential download correctness: once one download times out, attribution stops
// so a late completion is never attached to the next candidate. ---
test('BWAI-FILES-005: a timed-out download stops attribution for the rest', async (t) => {
    const cdp = {
        send: async (method: string) => {
            if (method === 'Runtime.evaluate') {
                return { result: { value: [
                    { href: 'https://chatgpt.com/backend-api/files/a/download' },
                    { href: 'https://chatgpt.com/backend-api/files/b/download' },
                ] } };
            }
            return { cookies: [{ name: 's', value: '1' }] };
        },
    };
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }) as typeof fetch;

    const res = await saveAssistantDownloadableFiles(cdp, {}, { sessionId: 'webai_x', perDownloadTimeoutMs: 500 });
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 0);
    assert.ok(res.warnings.some((w) => w.startsWith('file-artifact-timeout:')));
    assert.ok(res.warnings.some((w) => w.startsWith('file-artifact-skipped-after-timeout:')));
});
