// The automatic flush is merged: one extractor call summarises every session holding
// unflushed rows. These cases guard the invariants three discarded designs violated —
// a skipped row losing data, a session starving on one huge message, and a fixed
// session order starving the tail.
import '../setup/isolated-home.ts';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { settings } from '../../src/core/config.ts';
import { db } from '../../src/core/db.ts';
import { setActiveChatSession } from '../../src/core/chat-sessions.ts';
import { getMemoryFlushFilePath } from '../../src/memory/runtime.ts';
import {
    getFlushStatus,
    resetFlushCountersForTest,
    setSpawnRef,
    triggerMemoryFlush,
    triggerMemoryFlushForCurrentSession,
} from '../../src/agent/memory-flush-controller.ts';

type SpawnResult = { text: string; code: number };
type SpawnOptions = { lifecycle?: { onExit?: (code: number | null) => void } };
type SpawnPlan = SpawnResult | (() => Promise<SpawnResult>);

const memFile = () => getMemoryFlushFilePath(new Date().toISOString().slice(0, 10));
const readMemory = () => (fs.existsSync(memFile()) ? fs.readFileSync(memFile(), 'utf8') : '');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

/** Records every prompt handed to the extractor, which is where most of these
 *  assertions live: the merged conversation is an argument, not a side effect. */
function installSpawn(results: SpawnPlan[], prompts: string[] = []): string[] {
    let index = 0;
    setSpawnRef((prompt: string, opts: SpawnOptions) => {
        prompts.push(prompt);
        const plan = results[index++] ?? { text: 'summary', code: 0 };
        const next = typeof plan === 'function' ? plan() : plan;
        const promise = Promise.resolve(next).then(result => {
            opts.lifecycle?.onExit?.(result.code);
            return result;
        });
        return { child: null, promise };
    }, new Map());
    return prompts;
}

function insertRows(sessionId: string, marker: string, count: number, size = 0): number[] {
    const stmt = db.prepare(
        'INSERT INTO messages (role, content, cli, model, session_id, working_dir) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
        const body = size > 0 ? `${marker}-${i}-${'x'.repeat(size)}` : `${marker}-${i}`;
        const row = stmt.run(i % 2 === 0 ? 'user' : 'assistant', body, 'test', 'test', sessionId, settings.workingDir || null);
        ids.push(Number(row.lastInsertRowid));
    }
    return ids;
}

async function waitForFlushCompletion(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!getFlushStatus().locked) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail('memory flush did not release its lock');
}

function marks(): Record<string, number> {
    return getFlushStatus().lastFlushedMessageIdBySession as Record<string, number>;
}

beforeEach(() => {
    settings.multiSession.enabled = true;
    settings.memory.flushEvery = 10;
    db.prepare('DELETE FROM messages').run();
    // Rows and watermarks together: clearing one without the other leaves marks pointing
    // at ids that no longer exist, and the next case reads nothing.
    resetFlushCountersForTest();
});

after(() => {
    settings.multiSession.enabled = false;
});

for (const [i, id] of ['mg-a', 'mg-b', 'mg-c', 'mg-solo', 'mg-manual'].entries()) {
    db.prepare('INSERT OR IGNORE INTO chat_sessions (id, seq, label) VALUES (?, ?, ?)').run(id, 9700 + i, id);
}

test('MERGE-1/3: one flush covers every session, in one prompt and one entry', async () => {
    // The #454 shape: nine turns in A, one in B. The old per-session counter summarised
    // only B; the merged flush summarises both, so whose turn tripped it stops mattering.
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    insertRows('mg-a', 'from-a', 9);
    insertRows('mg-b', 'from-b', 1);
    const before = readMemory();

    setActiveChatSession('mg-b');
    assert.equal(await triggerMemoryFlush(), 'started');
    await waitForFlushCompletion();

    assert.equal(prompts.length, 1, 'exactly one extractor call, not one per session');
    assert.match(prompts[0] ?? '', /from-a-0/, "the session that filled the counter is in the prompt");
    assert.match(prompts[0] ?? '', /from-b-0/, 'and so is the one that spent it');

    const delta = readMemory().slice(before.length);
    assert.match(delta, /## \d{2}:\d{2}\n/, 'a merged entry carries a plain heading');
    assert.doesNotMatch(delta, /· session:/, 'no single session may claim a merged entry');
    assert.equal((delta.match(/^## /gm) ?? []).length, 1, 'one entry, not one per session');
});

test('MERGE-2: each contributing session advances its own watermark', async () => {
    installSpawn([{ text: 'merged summary', code: 0 }]);
    const aIds = insertRows('mg-a', 'wm-a', 3);
    const bIds = insertRows('mg-b', 'wm-b', 3);

    assert.equal(await triggerMemoryFlush(), 'started');
    await waitForFlushCompletion();

    assert.equal(marks()['mg-a'], aIds.at(-1), "A's mark is A's own last row");
    assert.equal(marks()['mg-b'], bIds.at(-1), "B's mark is B's own last row");
    assert.notEqual(marks()['mg-a'], marks()['mg-b'], 'one merged entry does not mean one shared mark');
});

test('MERGE-10: a session contributes an unbroken run of its rows', async () => {
    // The invariant every discarded design broke. A watermark claims everything at or
    // below an id is summarised, so a take with a hole in it makes the claim false.
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    const ids = insertRows('mg-a', 'run', 6);
    insertRows('mg-b', 'other', 2);

    await triggerMemoryFlush();
    await waitForFlushCompletion();

    const prompt = prompts[0] ?? '';
    for (let i = 0; i < 6; i++) {
        assert.match(prompt, new RegExp(`run-${i}`), `row ${i} must be present — no gaps`);
    }
    assert.equal(marks()['mg-a'], ids.at(-1));
});

test('MERGE-4/12: the manual flush stays single-session and keeps its heading', async () => {
    const prompts = installSpawn([{ text: 'manual summary', code: 0 }]);
    insertRows('mg-manual', 'mine', 4);
    insertRows('mg-b', 'theirs', 4);
    const before = readMemory();

    setActiveChatSession('mg-manual');
    assert.equal(await triggerMemoryFlushForCurrentSession(), 'started');
    await waitForFlushCompletion();

    assert.match(prompts[0] ?? '', /mine-0/);
    assert.doesNotMatch(prompts[0] ?? '', /theirs-0/, 'a manual flush means THIS conversation');
    assert.match(readMemory().slice(before.length), /· session:mg-manual/);
    assert.equal(marks()['mg-b'], undefined, 'an untouched session keeps no mark');
});

test('MERGE-12b: the manual path keeps the original four-row minimum', async () => {
    installSpawn([{ text: 'must not run', code: 0 }]);
    insertRows('mg-manual', 'short', 3);
    setActiveChatSession('mg-manual');
    assert.equal(await triggerMemoryFlushForCurrentSession(), 'insufficient',
        'lowering the merged minimum must not change what a person asked for');
});

test('MERGE-5: an oversized row is truncated rather than walling off its session', async () => {
    // Refusing to truncate would be the safer-looking choice and is the worse one: the
    // row becomes a permanent barrier and everything behind it is never summarised.
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    const ids = insertRows('mg-a', 'huge', 2, 20_000);

    await triggerMemoryFlush();
    await waitForFlushCompletion();

    const prompt = prompts[0] ?? '';
    assert.match(prompt, /… \[truncated\]/, 'the row is capped');
    assert.ok(prompt.length < 20_000, `the prompt stays bounded, saw ${prompt.length}`);
    assert.equal(marks()['mg-a'], ids.at(-1), 'and the watermark still passes the capped row');
});

test('MERGE-6: triggers arriving while the lock is held coalesce into one retry', async () => {
    const slow = deferred<SpawnResult>();
    const prompts = installSpawn([
        () => slow.promise,
        { text: 'retry summary', code: 0 },
    ]);
    insertRows('mg-a', 'first', 4);

    await triggerMemoryFlush();
    assert.equal(getFlushStatus().locked, true);

    insertRows('mg-b', 'queued', 4);
    assert.equal(await triggerMemoryFlush(), 'locked');
    assert.equal(await triggerMemoryFlush(), 'locked');
    assert.equal(await triggerMemoryFlush(), 'locked');
    assert.equal(getFlushStatus().pendingMergedFlush, true, 'three refusals, one pending bit');

    slow.resolve({ text: 'first summary', code: 0 });
    await waitForFlushCompletion();

    assert.equal(prompts.length, 2, 'the retry runs once, not once per refused trigger');
    assert.match(prompts[1] ?? '', /queued-0/);
    assert.equal(getFlushStatus().pendingMergedFlush, false);
});

test('MERGE-7: a lone session gets no separator', async () => {
    const prompts = installSpawn([{ text: 'solo summary', code: 0 }]);
    insertRows('mg-solo', 'alone', 4);

    await triggerMemoryFlush();
    await waitForFlushCompletion();

    assert.doesNotMatch(prompts[0] ?? '', /--- session /,
        'one session needs no boundary, and adding one would change every existing prompt');
});

test('MERGE-7b: several sessions are separated so the extractor cannot merge them', async () => {
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    insertRows('mg-a', 'first-topic', 2);
    insertRows('mg-b', 'second-topic', 2);

    await triggerMemoryFlush();
    await waitForFlushCompletion();

    const prompt = prompts[0] ?? '';
    assert.match(prompt, /--- session mg-a ---/);
    assert.match(prompt, /--- session mg-b ---/);
});

test('MERGE-11: flushEvery cannot widen the per-session query', async () => {
    // flushEvery sets cadence. Letting it also size the query means a user typing 10000
    // reads ten thousand rows per session.
    settings.memory.flushEvery = 10_000;
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    insertRows('mg-a', 'many', 25);

    await triggerMemoryFlush();
    await waitForFlushCompletion();

    const seen = (prompts[0] ?? '').match(/many-\d+/g) ?? [];
    assert.equal(seen.length, 10, `at most ten rows per session, saw ${seen.length}`);
});

test('MERGE-11b: a negative flushEvery cannot become an unbounded LIMIT', async () => {
    // SQLite reads LIMIT -1 as UNLIMITED, so a bare Math.min would turn a nonsense
    // setting into the opposite of a cap. The settings API does not validate this field.
    //
    // Clamping lands on 1 row per session, which is below the merged minimum of 2 — so
    // one session alone reports insufficient. Two sessions clear the minimum and prove
    // the clamp directly: one row each, not twenty-five.
    settings.memory.flushEvery = -1 as unknown as number;
    const prompts = installSpawn([{ text: 'merged summary', code: 0 }]);
    insertRows('mg-a', 'neg', 25);
    insertRows('mg-b', 'negb', 25);

    assert.equal(await triggerMemoryFlush(), 'started');
    await waitForFlushCompletion();

    const seen = (prompts[0] ?? '').match(/neg-\d+/g) ?? [];
    assert.equal(seen.length, 1, `a clamped limit reads one row, not an unbounded scan; saw ${seen.length}`);
});

test('MERGE-13: nothing to summarise reports insufficient and writes nothing', async () => {
    installSpawn([{ text: 'must not run', code: 0 }]);
    const before = readMemory();
    assert.equal(await triggerMemoryFlush(), 'insufficient');
    assert.equal(readMemory(), before);
});
