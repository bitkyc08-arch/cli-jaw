// Four commands used to answer the same question in four shapes. What is shared now is
// the part that was accidentally different; what stays apart is the part that differs for
// a reason. These pin both halves, because collapsing the second kind would be a feature
// change wearing a refactor's clothes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CHAT_BODY_LIMIT,
    formatFederatedResult,
    renderLocalChatHit,
} from '../../bin/commands/_shared/search-format.ts';
import { callDashboard, dashboardPort } from '../../bin/commands/_shared/dashboard-client.ts';

// ─── SF-1: the cross-instance skeleton is one renderer ───

test('SF-1: header and warnings come out the same whatever the hit is', () => {
    const shape = <T>(hits: T[], render: (hit: T) => string[]) => formatFederatedResult(
        { hits, instancesQueried: 3, instancesSucceeded: 2, warnings: [{ instanceId: 'i9', code: 'timeout', message: 'slow' }] },
        render,
    );

    const memory = shape([{ path: 'a.md' }], hit => [`\n[i1] ${hit.path}:4`, 'snippet']);
    const chat = shape([{ at: '2026-01-01' }], hit => [`\n[i1] ${hit.at} (user)`, 'body']);

    for (const out of [memory, chat]) {
        assert.match(out, /^# 1 hits across 2\/3 instances/);
        assert.match(out, /--- warnings ---\n\[i9\] timeout: slow$/);
    }
});

test('SF-1: an empty result still names the instance counts', () => {
    const out = formatFederatedResult({ hits: [], instancesQueried: 5, instancesSucceeded: 5, warnings: [] }, () => []);
    assert.equal(out, '# 0 hits across 5/5 instances');
});

test('SF-1: no warnings block appears when there are none', () => {
    const out = formatFederatedResult({ hits: [], instancesQueried: 1, instancesSucceeded: 1, warnings: [] }, () => []);
    assert.ok(!out.includes('warnings'));
});

// ─── SF-1b: the local commands did not grow a header ───

test('SF-1b: the local renderer emits one line and nothing else', () => {
    const line = renderLocalChatHit({ created_at: '2026-01-01', role: 'user', content: 'hello' });
    assert.equal(line, '[2026-01-01] (user) hello');
    assert.ok(!line.includes('#'), 'no header');
    assert.ok(!line.includes('instances'), 'no instance count — local search has no such concept');
    assert.equal(line.split('\n').length, 1);
});

// ─── SF-2: the two local commands agree on the body ───

test('SF-2: both local commands truncate a body at the same length', () => {
    const long = 'x'.repeat(CHAT_BODY_LIMIT + 500);
    const line = renderLocalChatHit({ created_at: 't', role: 'user', content: long });
    const body = line.slice('[t] (user) '.length);
    assert.equal(body.length, CHAT_BODY_LIMIT, 'one ceiling, not two');
});

test('SF-2: the context ceiling stays tighter than the hit itself', () => {
    const long = 'y'.repeat(500);
    const hit = renderLocalChatHit({ created_at: 't', role: 'user', content: long });
    const context = renderLocalChatHit({ created_at: 't', role: 'user', content: long }, 200);
    assert.ok(context.length < hit.length, 'context lines are for orientation, not reading');
});

test('SF-2: missing fields render without throwing', () => {
    assert.equal(renderLocalChatHit({}), '[] () ');
    assert.doesNotThrow(() => renderLocalChatHit({ content: null, role: 42, created_at: undefined }));
});

// ─── SF-3: the client names the command that called it ───

test('SF-3: an unreachable dashboard reports the caller by name', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await assert.rejects(
        () => callDashboard({ basePath: '/api/dashboard/memory', path: '/search', label: 'dashboard chat', fetchImpl: failing }),
        /dashboard chat unreachable/,
    );
    await assert.rejects(
        () => callDashboard({ basePath: '/api/dashboard/memory', path: '/search', label: 'dashboard memory', fetchImpl: failing }),
        /dashboard memory unreachable/,
    );
});

test('SF-3: an error status carries the caller name and a bounded body', async () => {
    const huge = 'z'.repeat(1000);
    const failing = (async () => new Response(huge, { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(
        () => callDashboard({ basePath: '/api/dashboard/memory', path: '/read', label: 'dashboard memory', fetchImpl: failing }),
        (err: Error) => {
            assert.match(err.message, /dashboard memory \/read → 500/);
            assert.ok(err.message.length < 400, 'the upstream body is truncated');
            return true;
        },
    );
});

// ─── SF-4: the URL the chat command builds is unchanged ───

test('SF-4: chat search still goes to the memory router', async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => { seen.push(String(url)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;

    await callDashboard({
        basePath: '/api/dashboard/memory',
        path: '/chat/search?q=hello',
        label: 'dashboard chat',
        fetchImpl: spy,
    });

    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /\/api\/dashboard\/memory\/chat\/search\?q=hello$/,
        'the chat CLI is mounted under the memory router, and moving it would 404');
    assert.match(seen[0]!, new RegExp(`^http://127\\.0\\.0\\.1:${dashboardPort()}/`));
});

// ─── SF-3b/SF-3c: POST goes through the same client ───

test('SF-3b: a POST sends its body and content type', async () => {
    let method = '';
    let body: unknown;
    let contentType: string | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
        method = String(init.method || 'GET');
        body = init.body;
        contentType = (init.headers as Record<string, string>)['Content-Type'];
        return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const out = await callDashboard<{ ok: boolean }>({
        basePath: '/api/dashboard/memory',
        path: '/reindex',
        label: 'dashboard memory',
        body: { full: true },
        fetchImpl: spy,
    });

    assert.equal(method, 'POST');
    assert.equal(body, '{"full":true}');
    assert.equal(contentType, 'application/json');
    assert.deepEqual(out, { ok: true });
});

test('SF-3c: a GET sends no body and no content type', async () => {
    let init: RequestInit = {};
    const spy = (async (_url: string, got: RequestInit) => { init = got; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;

    await callDashboard({ basePath: '/api/dashboard/memory', path: '/instances', label: 'dashboard memory', fetchImpl: spy });

    assert.equal(init.method, undefined, 'a read stays a plain GET');
    assert.equal(init.body, undefined);
    assert.equal((init.headers as Record<string, string>)['Content-Type'], undefined);
});
