// Cycle 2 (parity2 020): durable conversation-URL validation, CDP liveness
// classification, and fail-closed recovery semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDurableConversationId, isDurableConversationUrl } from '../../src/browser/web-ai/conversation-url.ts';
import { probeCdpLiveness, isRecoverableCdpDisconnect } from '../../src/browser/web-ai/cdp-liveness.ts';
import { probeTabAlive, isSafeChatGptConversationUrl, urlsCompatible } from '../../src/browser/web-ai/tab-recovery.ts';

test('CU-001: canonical conversation URLs are durable', () => {
    assert.equal(extractDurableConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
    assert.equal(extractDurableConversationId('https://chat.openai.com/c/ABC123'), 'ABC123');
    assert.equal(extractDurableConversationId('https://chatgpt.com/g/g-xyz/c/id-1'), 'id-1');
});

test('CU-002: unsafe URLs are rejected', () => {
    for (const bad of [
        'http://chatgpt.com/c/x',              // not https
        'https://evil.example/c/x',            // foreign host
        'https://chatgpt.com:8443/c/x',        // explicit port
        'https://chatgpt.com/c/../y',          // traversal
        'https://chatgpt.com/\\c/x',         // backslash smuggling
        'https://chatgpt.com/',                // bare origin
        'https://chatgpt.com/work',            // no /c/ id
        '', null, undefined,
    ]) {
        assert.equal(isDurableConversationUrl(bad as string), false, `should reject: ${bad}`);
    }
});

test('CDP-001: liveness decision table', async () => {
    const mkFetch = (version: boolean, list: unknown) => (async (url: string) => {
        if (String(url).includes('/json/version')) {
            if (!version) throw new Error('ECONNREFUSED');
            return { ok: true } as Response;
        }
        return { ok: true, json: async () => list } as unknown as Response;
    }) as typeof fetch;

    const alive = await probeCdpLiveness({ port: 9222, targetId: 'T1', fetchImpl: mkFetch(true, [{ id: 'T1', url: 'https://chatgpt.com/c/x' }]) });
    assert.equal(isRecoverableCdpDisconnect(alive), true);
    assert.equal(alive.matchedUrl, 'https://chatgpt.com/c/x');

    const gone = await probeCdpLiveness({ port: 9222, targetId: 'T1', fetchImpl: mkFetch(true, [{ id: 'T2' }]) });
    assert.deepEqual({ reach: gone.endpointReachable, found: gone.targetFound }, { reach: true, found: false });
    assert.equal(isRecoverableCdpDisconnect(gone), false);

    const down = await probeCdpLiveness({ port: 9222, targetId: 'T1', fetchImpl: mkFetch(false, []) });
    assert.equal(down.endpointReachable, false);
    assert.equal(isRecoverableCdpDisconnect(down), false);
});

test('TR-001: probeTabAlive maps liveness fail-closed', async () => {
    // No targetId → unknown (never dead)
    assert.equal(await probeTabAlive(9222, null), 'unknown');
    assert.equal(await probeTabAlive(9222, ''), 'unknown');
    // Endpoint down → unknown (we could not observe; may not replace)
    const dead = await probeTabAlive(1, 'T1'); // nothing listens on port 1
    assert.equal(dead, 'unknown');
});

test('TR-002: urlsCompatible matches agbrowse semantics', () => {
    assert.equal(urlsCompatible('https://chatgpt.com/c/x', 'https://chatgpt.com/c/x'), true);
    assert.equal(urlsCompatible('https://chatgpt.com/c/x', 'https://chatgpt.com/c/x/sub'), true);
    assert.equal(urlsCompatible('https://chatgpt.com/', 'https://chatgpt.com/c/x'), true); // root is compatible
    assert.equal(urlsCompatible('https://chatgpt.com/c/x', 'https://chatgpt.com/c/y'), false);
    assert.equal(urlsCompatible('https://chatgpt.com/c/x', 'https://evil.example/c/x'), false);
    assert.equal(urlsCompatible(null, 'https://chatgpt.com/'), false);
});

test('TR-003: isSafeChatGptConversationUrl delegates to durable validation', () => {
    assert.equal(isSafeChatGptConversationUrl('https://chatgpt.com/c/abc'), true);
    assert.equal(isSafeChatGptConversationUrl('https://chatgpt.com/'), false);
});

