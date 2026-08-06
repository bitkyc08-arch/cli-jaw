// The vault has to stay readable without this program, so normalization reports what it
// could not understand instead of refusing the note. These tests pin that: every hostile
// or sloppy input still returns a usable result alongside its warnings.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOntology } from '../../src/wiki/ontology.ts';

const PATH = 'entities/ada.md';

test('ONT-1: the three kinds are indexed and the id is trimmed', () => {
    for (const kind of ['person', 'project', 'system'] as const) {
        const result = normalizeOntology(PATH, { entity: { kind, id: '  ada  ' } });
        assert.deepEqual(result.entity, { kind, id: 'ada' });
        assert.deepEqual(result.warnings, []);
    }
});

test('ONT-1b: an unusable id leaves the entity without one', () => {
    for (const id of ['   ', '', 42, null, { nested: true }]) {
        const result = normalizeOntology(PATH, { entity: { kind: 'person', id } });
        assert.deepEqual(result.entity, { kind: 'person' });
        assert.ok(!('id' in (result.entity ?? {})), 'no id key at all, not an undefined one');
    }
});

test('ONT-2: an unknown kind warns and yields no entity', () => {
    const result = normalizeOntology(PATH, { entity: { kind: 'organisation', id: 'acme' } });
    assert.equal(result.entity, undefined);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, 'invalid_entity_kind');
});

test('ONT-2b: a missing entity is silent, a malformed one is not', () => {
    assert.deepEqual(normalizeOntology(PATH, {}).warnings, [], 'an ordinary note draws no complaint');
    assert.deepEqual(normalizeOntology(PATH, { entity: null }).warnings, []);

    for (const entity of ['person', 42, ['person'], true]) {
        const result = normalizeOntology(PATH, { entity });
        assert.equal(result.entity, undefined);
        assert.equal(result.warnings[0]?.code, 'invalid_entity_kind', `${JSON.stringify(entity)} warns`);
    }
});

test('ONT-3: a relation missing either half is dropped with a warning', () => {
    const result = normalizeOntology(PATH, {
        relations: [
            { type: 'works-on', target: '   ' },
            { type: '', target: 'jaw' },
            { target: 'jaw' },
            { type: 'knows' },
            'not-an-object',
        ],
    });
    assert.deepEqual(result.relations, []);
    assert.equal(result.warnings.length, 5);
    assert.ok(result.warnings.every(w => w.code === 'invalid_relation'));
});

test('ONT-3b: a repeat after trimming keeps the first and warns once', () => {
    const result = normalizeOntology(PATH, {
        relations: [
            { type: 'works-on', target: 'jaw' },
            { type: '  works-on  ', target: '  jaw  ' },
        ],
    });
    assert.deepEqual(result.relations, [{ type: 'works-on', target: 'jaw' }]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, 'duplicate_relation');
});

test('ONT-3c: valid relations survive alongside invalid ones, in order', () => {
    const result = normalizeOntology(PATH, {
        relations: [
            { type: 'works-on', target: 'jaw' },
            { type: '', target: 'dropped' },
            { type: 'knows', target: 'grace' },
            { type: 'works-on', target: 'jaw' },
            { type: 'wrote', target: 'notes' },
        ],
    });
    assert.deepEqual(result.relations, [
        { type: 'works-on', target: 'jaw' },
        { type: 'knows', target: 'grace' },
        { type: 'wrote', target: 'notes' },
    ]);
    assert.deepEqual(result.warnings.map(w => w.code), ['invalid_relation', 'duplicate_relation']);
});

test('ONT-3d: relations that are not a list are ignored rather than guessed at', () => {
    for (const relations of ['works-on', 42, { type: 'works-on', target: 'jaw' }, null]) {
        const result = normalizeOntology(PATH, { relations });
        assert.deepEqual(result.relations, []);
        assert.deepEqual(result.warnings, []);
    }
});

test('ONT-4: every warning carries the path it was given', () => {
    const result = normalizeOntology('concepts/other.md', {
        entity: { kind: 'nope' },
        relations: [{ type: '', target: '' }, { type: 'a', target: 'b' }, { type: 'a', target: 'b' }],
    });
    assert.equal(result.warnings.length, 3);
    assert.ok(result.warnings.every(w => w.path === 'concepts/other.md'));
});

test('ONT-5: nothing here throws, whatever it is handed', () => {
    const hostile: Record<string, unknown>[] = [
        {},
        { entity: Object.create(null) },
        { relations: [undefined, null, 0] },
        { entity: { kind: 'person', id: Symbol('x').toString() }, relations: [[]] },
    ];
    for (const data of hostile) {
        assert.doesNotThrow(() => normalizeOntology(PATH, data));
    }
});
