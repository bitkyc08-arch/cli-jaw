import test from 'node:test';
import assert from 'node:assert/strict';
import { readActivityRun, readActivityRuns, type ActivityReader } from '../../src/shared/activity-read.js';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';

const identity = { version: 1 as const, runId: 'tr_abcdefghijklmnop', sessionId: 'chat & 한글', scope: 'local:chat', turnId: 'turn' };
const event = (seq: number, text = 'part'): RuntimeEvent => ({
    ...identity, seq, kind: 'message', itemId: 'message', operation: 'append', phase: 'commentary', text,
});
function page(events: unknown[] = [], overrides: Record<string, unknown> = {}) {
    return { runId: identity.runId, sessionId: identity.sessionId, scope: identity.scope,
        events, through: 100, nextAfter: 100, hasMore: false, incomplete: false, loss: null, ...overrides };
}
function fixture(pages: unknown[]) {
    const controller = new AbortController();
    const paths: string[] = [];
    const read: ActivityReader = async (path, signal) => {
        assert.equal(signal, controller.signal);
        paths.push(path);
        assert.ok(paths.length <= pages.length, 'unexpected extra read');
        return pages[paths.length - 1];
    };
    return { runId: identity.runId, sessionId: identity.sessionId, signal: controller.signal, controller, paths, read };
}
const summary = (index: number) => ({ id: `tr_${String(index).padStart(16, '0')}`,
    messageId: index + 1, status: 'done' as const, startedAt: 100_000 - index });
const discovery = (start: number, count: number) => ({ runs: Array.from({ length: count }, (_, i) => summary(start + i)), pageSize: 40 });

test('fixed snapshot uses exact encoded route and the injected signal, with sparse sequences', async () => {
    const input = fixture([{ ok: true, data: page([event(2), event(9)], { nextAfter: 9, hasMore: true }) },
        page([event(37), event(100)])]);
    const result = await readActivityRun(input);
    assert.deepEqual(result, { events: [event(2), event(9), event(37), event(100)],
        through: 100, scope: identity.scope, incomplete: false, loss: null });
    const query = new URLSearchParams({ session: identity.sessionId, after: '0', limit: '40' });
    assert.equal(input.paths[0], `/api/traces/${identity.runId}/activity?${query}`);
    query.set('after', '9'); query.set('through', '100');
    assert.equal(input.paths[1], `/api/traces/${identity.runId}/activity?${query}`);
});

test('run ID is encoded as one path component', async () => {
    const input = fixture([page([], { runId: 'run/a?b', through: 0, nextAfter: 0 })]);
    await readActivityRun({ ...input, runId: 'run/a?b' });
    assert.ok(input.paths[0]!.startsWith('/api/traces/run%2Fa%3Fb/activity?'));
});

for (const [name, patch] of Object.entries({
    run: { runId: 'foreign' }, session: { sessionId: 'foreign' }, scope: { scope: '' },
    'long scope': { scope: 's'.repeat(241) }, through: { through: -1 },
    'unsafe through': { through: Number.MAX_SAFE_INTEGER + 1 }, 'fractional cursor': { nextAfter: 1.5 },
    'cursor past snapshot': { nextAfter: 101 }, 'hasMore type': { hasMore: 1 },
    'incomplete type': { incomplete: 'false' }, loss: { loss: {} }, events: { events: {} },
})) {
    test(`rejects invalid page ${name}`, async () => {
        await assert.rejects(readActivityRun(fixture([page([], patch)])), /invalid_activity_/);
    });
}

for (const [name, patch] of Object.entries({ run: { runId: 'foreign' }, session: { sessionId: 'foreign' },
    scope: { scope: 'foreign' }, turn: { turnId: '' }, version: { version: 2 }, seq: { seq: 0 },
    body: { operation: 'invalid' }, 'past nextAfter': { seq: 11 }, 'past through': { seq: 101 } })) {
    test(`rejects invalid event ${name}`, async () => {
        await assert.rejects(readActivityRun(fixture([page([{ ...event(1), ...patch }], { nextAfter: 10 })])), /invalid_activity_identity/);
    });
}

for (const seqs of [[5, 3], [5, 5]]) {
    test(`rejects unordered/duplicate events ${seqs}`, async () => {
        await assert.rejects(readActivityRun(fixture([page(seqs.map(seq => event(seq)))])), /unordered_activity_page/);
    });
}

test('rejects a replayed event at the prior cursor', async () => {
    await assert.rejects(readActivityRun(fixture([page([event(5)], { nextAfter: 5, hasMore: true }), page([event(5)])])), /invalid_activity_identity/);
});

for (const [field, value, error] of [['through', 101, 'activity_cursor_changed'], ['scope', 'other', 'activity_scope_changed']] as const) {
    test(`rejects changed ${field} on an empty later page`, async () => {
        await assert.rejects(readActivityRun(fixture([page([event(5)], { nextAfter: 5, hasMore: true }), page([], { [field]: value })])), new RegExp(error));
    });
}

test('cursor cannot retreat on a later page', async () => {
    await assert.rejects(readActivityRun(fixture([page([event(5)], { nextAfter: 5, hasMore: true }), page([], { nextAfter: 4 })])), /invalid_activity_cursor/);
});

test('hasMore requires advancement even if no valid rows were returned', async () => {
    await assert.rejects(readActivityRun(fixture([page([], { nextAfter: 0, hasMore: true })])), /activity_cursor_stalled/);
});

test('empty terminal page can keep its cursor below through', async () => {
    const input = fixture([page([event(5)], { nextAfter: 5, hasMore: true }), page([], { nextAfter: 5 })]);
    assert.deepEqual((await readActivityRun(input)).events, [event(5)]);
    const empty = await readActivityRun(fixture([page([], { through: 0, nextAfter: 0 })]));
    assert.equal(empty.through, 0);
    assert.equal(empty.incomplete, false);
});

test('corrupt rows advance the cursor and their loss survives later clean pages', async () => {
    const input = fixture([page([event(2)], { nextAfter: 5, hasMore: true, incomplete: true, loss: 'corrupt' }),
        page([], { nextAfter: 9, hasMore: true, incomplete: true, loss: 'corrupt' }), page([event(100)])]);
    const result = await readActivityRun(input);
    assert.equal(result.loss, 'corrupt'); assert.equal(result.incomplete, true);
    assert.deepEqual(result.events, [event(2), event(100)]);
    assert.equal(new URL(input.paths[2]!, 'http://local').searchParams.get('after'), '9');
});

test('incomplete is sticky independently of loss and loss never produces a complete result', async () => {
    const result = await readActivityRun(fixture([page([], { nextAfter: 1, hasMore: true, incomplete: true }), page([])]));
    assert.equal(result.incomplete, true); assert.equal(result.loss, null);
    assert.equal((await readActivityRun(fixture([page([], { loss: 'retention' })]))).incomplete, true);
});

test('canonical parser strips unknown event fields and preserves empty/null final answers', async () => {
    const events = [null, ''].map((finalText, i) => ({ ...identity, seq: i + 1, kind: 'turn-end', status: 'done', finalText }));
    const result = await readActivityRun(fixture([page(events.map(e => ({ ...e, privateField: 'drop' })))]));
    assert.deepEqual(result.events, events);
});

for (const reader of [readActivityRun, readActivityRuns]) {
    test(`${reader.name}: failed or malformed envelope cannot fall back to bare fields`, async () => {
        const bare = reader === readActivityRun ? page() : discovery(0, 0);
        for (const envelope of [{ ok: false }, { ok: 'true' }, { ok: true }, { ok: true, data: null }, { data: bare }, { ok: false, data: bare }]) {
            await assert.rejects(reader(fixture([{ ...bare, ...envelope }])), /invalid_activity_envelope/);
        }
    });
    test(`${reader.name}: pre-abort makes no call, late abort cannot return success`, async () => {
        const input = fixture([reader === readActivityRun ? page() : discovery(0, 0)]);
        input.controller.abort();
        await assert.rejects(reader(input), { name: 'AbortError' });
        assert.equal(input.paths.length, 0);
        const late = fixture([reader === readActivityRun ? page() : discovery(0, 0)]);
        await assert.rejects(reader({ ...late, read: async (path, signal) => {
            const result = await late.read(path, signal); late.controller.abort(); return result;
        } }), { name: 'AbortError' });
    });
    test(`${reader.name}: injected HTTP errors preserve identity`, async () => {
        const failure = new Error('trace_not_found');
        await assert.rejects(reader({ ...fixture([]), read: async () => { throw failure; } }), error => error === failure);
    });
    test(`${reader.name}: invalid session is rejected before reading`, async () => {
        const input = fixture([]);
        await assert.rejects(reader({ ...input, sessionId: '' }), /invalid_activity_identity/);
        assert.equal(input.paths.length, 0);
    });
}

test('rejects 41 events and oversized UTF-8 page including envelope metadata', async () => {
    await assert.rejects(readActivityRun(fixture([page(Array.from({ length: 41 }, (_, i) => event(i + 1)))])), /invalid_activity_page/);
    await assert.rejects(readActivityRun(fixture([page([event(1, '한'.repeat(100_000))])])), /activity_page_limit/);
    await assert.rejects(readActivityRun(fixture([{ ok: true, data: page(), metadata: 'x'.repeat(270_000) }])), /activity_page_limit/);
});

test('page byte limit accepts equality and rejects one byte more', async () => {
    const body = { ...page(), padding: '' };
    const size = new TextEncoder().encode(JSON.stringify(body)).length;
    body.padding = 'x'.repeat(270_000 - size);
    await readActivityRun(fixture([body]));
    await assert.rejects(readActivityRun(fixture([{ ...body, padding: body.padding + 'x' }])), /activity_page_limit/);
});

function manyEvents(count: number) {
    const pages = [];
    for (let start = 0; start < count; start += 40) {
        const end = Math.min(count, start + 40);
        pages.push(page(Array.from({ length: end - start }, (_, i) => event(start + i + 1)),
            { through: count, nextAfter: end, hasMore: end < count }));
    }
    return pages;
}
test('run event cap accepts 4096 and rejects 4097 without returning a partial success', async () => {
    assert.equal((await readActivityRun(fixture(manyEvents(4096)))).events.length, 4096);
    await assert.rejects(readActivityRun(fixture(manyEvents(4097))), /activity_run_limit/);
});

test('aggregate event bytes are bounded at exactly 4 MiB', async () => {
    const events = Array.from({ length: 22 }, (_, i) => event(i + 1, i < 21 ? 'x'.repeat(199_000) : ''));
    const used = events.reduce((sum, e) => sum + new TextEncoder().encode(JSON.stringify(e)).length, 0);
    const tail = events[21]!;
    assert.ok(tail.kind === 'message');
    tail.text = 'x'.repeat(4 * 1024 * 1024 - used);
    const pages = () => events.map((e, i) => page([e], { through: 22, nextAfter: i + 1, hasMore: i < 21 }));
    assert.equal((await readActivityRun(fixture(pages()))).events.length, 22);
    tail.text += 'x';
    await assert.rejects(readActivityRun(fixture(pages())), /activity_run_limit/);
});

test('bounds pages even when a server keeps advancing over missing rows', async () => {
    let calls = 0;
    const input = fixture([]);
    await assert.rejects(readActivityRun({ ...input, read: async () => page([], {
        through: 10_000, nextAfter: ++calls, hasMore: true, incomplete: true, loss: 'corrupt',
    }) }), /activity_page_count_limit/);
    assert.equal(calls, 4097);
});

test('discovery uses ascending opaque IDs, not timestamps, and stops on a short page', async () => {
    const input = fixture([{ ok: true, data: discovery(0, 40) }, discovery(40, 2)]);
    const result = await readActivityRuns(input);
    assert.deepEqual(result, { runs: [...discovery(0, 40).runs, ...discovery(40, 2).runs], incomplete: false });
    const query = new URLSearchParams({ session: identity.sessionId, after: '' });
    assert.equal(input.paths[0], `/api/traces/activity-runs?${query}`);
    query.set('after', summary(39).id);
    assert.equal(input.paths[1], `/api/traces/activity-runs?${query}`);
});

test('discovery accepts empty and nullable message IDs and every declared status', async () => {
    assert.deepEqual(await readActivityRuns(fixture([discovery(0, 0)])), { runs: [], incomplete: false });
    const runs = ['running', 'done', 'error', 'interrupted'].map((status, i) => ({ ...summary(i), status, messageId: null }));
    assert.deepEqual((await readActivityRuns(fixture([{ runs, pageSize: 40 }]))).runs, runs);
});

test('discovery full page requires an empty terminal read', async () => {
    const input = fixture([discovery(0, 40), discovery(40, 0)]);
    assert.equal((await readActivityRuns(input)).incomplete, false);
    assert.equal(input.paths.length, 2);
});

test('discovery caps retained rows at 256 and exposes incomplete', async () => {
    const input = fixture(Array.from({ length: 7 }, (_, i) => discovery(i * 40, 40)));
    const result = await readActivityRuns(input);
    assert.equal(result.runs.length, 256); assert.equal(result.incomplete, true);
    assert.equal(result.runs[255]!.id, summary(255).id); assert.equal(input.paths.length, 7);
});

test('discovery is conservative at the exact bound', async () => {
    const input = fixture([...Array.from({ length: 6 }, (_, i) => discovery(i * 40, 40)), discovery(240, 16)]);
    const result = await readActivityRuns(input);
    assert.equal(result.runs.length, 256); assert.equal(result.incomplete, true);
});

test('discovery validates shape, byte budget, and optional session echo', async () => {
    for (const data of [null, { pageSize: 40 }, { ...discovery(0, 0), pageSize: 20 }, discovery(0, 41),
        { ...discovery(0, 0), sessionId: 'foreign' }]) {
        await assert.rejects(readActivityRuns(fixture([data])), /invalid_activity_runs_page/);
    }
    await assert.rejects(readActivityRuns(fixture([{ ...discovery(0, 0), extra: 'x'.repeat(270_000) }])), /activity_page_limit/);
});

for (const [name, patch] of Object.entries({ id: { id: '' }, 'long id': { id: 'x'.repeat(241) },
    message: { messageId: '1' }, 'negative message': { messageId: -1 }, status: { status: 'stopped' },
    time: { startedAt: 'today' }, 'infinite time': { startedAt: Infinity }, session: { sessionId: 'foreign' } })) {
    test(`discovery rejects invalid row ${name}`, async () => {
        await assert.rejects(readActivityRuns(fixture([{ runs: [{ ...summary(0), ...patch }], pageSize: 40 }])), /invalid_activity_run/);
    });
}

test('discovery rejects unordered IDs, duplicates, and a cross-page stalled cursor', async () => {
    for (const runs of [[summary(2), summary(1)], [summary(1), summary(1)]]) {
        await assert.rejects(readActivityRuns(fixture([{ runs, pageSize: 40 }])), /activity_runs_cursor_stalled/);
    }
    await assert.rejects(readActivityRuns(fixture([discovery(0, 40), discovery(39, 1)])), /activity_runs_cursor_stalled/);
});
