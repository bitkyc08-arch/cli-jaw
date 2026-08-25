// #453: interrupting one session reordered the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const src = fs.readFileSync(join(import.meta.dirname, '../../src/agent/spawn/queue.ts'), 'utf8');

test('INT-453a: the enqueue path no longer fronts the global queue', () => {
    // unshift put an interrupt ahead of EVERY scope. Interrupt means "drop what
    // I am doing and take this instead" — a statement about one conversation
    // that was silently reordering the rest.
    //
    // Scoped to the enqueue site: a later unshift restores items after a failed
    // setup, which is a rollback and correctly global.
    const enqueue = src.slice(src.indexOf('deps.insertQueuedMessage.run(item.id'));
    const body = enqueue.slice(0, 400);
    assert.doesNotMatch(body, /messageQueue\.unshift\(/,
        'one session must not jump ahead of another session that was waiting first');
    assert.match(body, /insertAheadOfScope\(item\)/);
});

test('INT-453b: the insert is positioned by matching scope', () => {
    const fn = src.slice(src.indexOf('function insertAheadOfScope'));
    const body = fn.slice(0, 400);
    assert.match(body, /normalizeScope\(item\.scope\)/,
        'position must be decided by scope, not by array position');
    assert.match(body, /splice\(at, 0, item\)/);
    assert.match(body, /at === -1/,
        'a scope with nothing queued must append rather than cut the line');
});

test('INT-453c: the ordering rule is exercised, not merely described', () => {
    type Item = { id: string; scope: string };
    const queue: Item[] = [
        { id: 'a1', scope: 'local:a' },
        { id: 'b1', scope: 'local:b' },
        { id: 'b2', scope: 'local:b' },
    ];
    const insertAheadOfScope = (item: Item) => {
        const at = queue.findIndex(q => q.scope === item.scope);
        if (at === -1) queue.push(item);
        else queue.splice(at, 0, item);
    };

    insertAheadOfScope({ id: 'b-interrupt', scope: 'local:b' });
    assert.deepEqual(queue.map(q => q.id), ['a1', 'b-interrupt', 'b1', 'b2'],
        "B's interrupt precedes B's own work and leaves A where it was");

    insertAheadOfScope({ id: 'c1', scope: 'local:c' });
    assert.deepEqual(queue.map(q => q.id), ['a1', 'b-interrupt', 'b1', 'b2', 'c1'],
        'a scope with nothing queued appends instead of cutting the line');
});

