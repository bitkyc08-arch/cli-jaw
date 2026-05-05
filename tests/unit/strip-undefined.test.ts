import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUndefined, stripUndefinedAll } from '../../src/core/strip-undefined.js';

test('stripUndefined removes only own undefined values', () => {
    const input = {
        a: undefined,
        b: 1,
        c: null,
        d: 0,
        e: '',
        f: false,
        g: Number.NaN,
    };
    const result = stripUndefined(input);

    assert.deepEqual(Object.keys(result), ['b', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(result.b, 1);
    assert.equal(result.c, null);
    assert.equal(result.d, 0);
    assert.equal(result.e, '');
    assert.equal(result.f, false);
    assert.equal(Number.isNaN(result.g), true);
    assert.equal(Object.hasOwn(result, 'a'), false);
});

test('stripUndefined is shallow and does not mutate input', () => {
    const nested = { child: undefined };
    const input = { a: undefined, nested };
    const result = stripUndefined(input);

    assert.deepEqual(result, { nested });
    assert.deepEqual(input, { a: undefined, nested });
    assert.equal(Object.hasOwn(result.nested, 'child'), true);
});

test('stripUndefinedAll strips each object in order', () => {
    assert.deepEqual(stripUndefinedAll([{ a: undefined, b: 1 }, { a: 'x' }]), [
        { b: 1 },
        { a: 'x' },
    ]);
});

test('stripUndefined preserves assignability for exact optional objects', () => {
    const value: { a?: number } = stripUndefined({ a: 1 as number | undefined });
    assert.deepEqual(value, { a: 1 });
});
