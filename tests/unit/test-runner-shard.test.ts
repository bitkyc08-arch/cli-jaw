import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs, partitionFiles, SCOPES } from '../setup/shard.ts';

const SAMPLE = ['tests/z.test.ts', 'tests/unit/b.test.ts', 'tests/a.test.ts', 'tests/unit/a.test.ts',
    'tests/unit/c.test.ts', 'tests/unit/B.test.ts', 'tests/m.test.ts', 'tests/unit/a-b.test.ts',
    'tests/unit/a_b.test.ts', 'tests/unit/d.test.ts'];

function partitions(files: readonly string[], total: number): string[][] {
    return Array.from({ length: total }, (_, i) => partitionFiles(files, { index: i + 1, total }));
}

test('SHARD-001: shards are disjoint, complete and balanced for N=1..4', () => {
    const whole = partitionFiles(SAMPLE);
    assert.equal(whole.length, SAMPLE.length);
    for (const total of [1, 2, 3, 4]) {
        const parts = partitions(SAMPLE, total);
        const union = parts.flat();
        assert.deepEqual([...union].sort(), [...whole].sort(), `N=${total} union`);
        assert.equal(new Set(union).size, union.length, `N=${total} disjoint`);
        const sizes = parts.map(p => p.length);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `N=${total} balanced: ${sizes}`);
    }
});

test('SHARD-002: partition is stable under permutation and duplicates, and never mutates input', () => {
    const shuffled = [...SAMPLE].reverse();
    const duplicated = [...SAMPLE, ...SAMPLE.slice(0, 3)];
    const frozen = Object.freeze([...SAMPLE]);
    for (const total of [2, 3]) {
        for (let i = 1; i <= total; i++) {
            const expected = partitionFiles(SAMPLE, { index: i, total });
            assert.deepEqual(partitionFiles(shuffled, { index: i, total }), expected);
            assert.deepEqual(partitionFiles(duplicated, { index: i, total }), expected);
            assert.deepEqual(partitionFiles(frozen, { index: i, total }), expected);
        }
    }
    assert.deepEqual([...frozen], SAMPLE);
});

test('SHARD-003: ordering is byte order (LC_ALL=C), not locale collation', () => {
    assert.deepEqual(partitionFiles(['b', 'B', 'a-', 'a']), ['B', 'a', 'a-', 'b']);
    assert.deepEqual(partitionFiles(['tests/unit/a_b', 'tests/unit/a-b', 'tests/unit/a.b']),
        ['tests/unit/a-b', 'tests/unit/a.b', 'tests/unit/a_b']);
});

test('SHARD-004: real tree — 4 shards of root+unit reproduce the collection exactly', () => {
    const testsDir = resolve(import.meta.dirname, '..');
    const flat = (dir: string) => readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.test.ts'))
        .map(e => join(dir, e.name).split(sep).join('/'));
    const collection = [...flat(testsDir), ...flat(join(testsDir, 'unit'))];
    assert.ok(collection.length > 100, 'collector saw the real tree');
    const parts = partitions(collection, 4);
    const union = parts.flat();
    assert.equal(union.length, collection.length);
    assert.equal(new Set(union).size, collection.length);
    assert.deepEqual([...union].sort(), [...collection].sort());
    assert.ok(union.includes(import.meta.filename.split(sep).join('/')), 'this file is in the partition');
});

test('SHARD-005: parseArgs accepts the documented grammar', () => {
    const o = parseArgs(['--scope', 'unit,root', '--scope', 'unit', '--shard', '2/4', '--list']);
    assert.deepEqual(o.scopes, ['unit', 'root']);
    assert.deepEqual(o.shard, { index: 2, total: 4 });
    assert.equal(o.list, true);
    assert.deepEqual(parseArgs(['--', '--weird', 'x']).explicit, ['--weird', 'x']);
    assert.deepEqual(parseArgs(['tests/unit/a.test.ts', '--all']).explicit, ['tests/unit/a.test.ts']);
    assert.deepEqual([...SCOPES], ['root', 'unit', 'integration', 'manager', 'browser', 'bin']);
});

test('SHARD-006: parseArgs rejects malformed and conflicting arguments', () => {
    const bad: string[][] = [
        ['--shard', '0/4'], ['--shard', '5/4'], ['--shard', 'a/b'], ['--shard'], ['--shard', '--list'],
        ['--shard', '1/2', '--shard', '2/2'], ['--scope', 'nope'], ['--scope', 'unit', '--all'],
        ['--scope', 'unit', 'tests/x.test.ts'], ['--watch', '--shard', '1/2'], ['--watch', '--list'], ['--bogus'],
    ];
    for (const argv of bad) assert.throws(() => parseArgs(argv), `should reject: ${argv.join(' ')}`);
    assert.throws(() => partitionFiles(['a'], { index: 2, total: 1 }), /1 <= i <= N/);
});

