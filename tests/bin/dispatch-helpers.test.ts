// Unit tests for the 260703 dispatch-affordance CLI helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readTaskFile, parseTaskTagsFlag } from '../../bin/commands/dispatch-helpers.js';

function tmpFile(content: string): string {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'jaw-dispatch-helpers-'));
    const p = join(dir, 'brief.md');
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

test('readTaskFile: happy path returns file content', () => {
    const p = tmpFile('Project root: /repo\n\nTask: verify imports resolve.');
    const r = readTaskFile(p);
    assert.equal(r.ok, true);
    assert.ok(r.content?.includes('verify imports resolve'));
});

test('readTaskFile: preserves multi-line UTF-8 content (no shell mangling)', () => {
    const brief = '작업 지시: "따옴표"와 `백틱` 포함\n{"json": [1, 2]}\n$VAR und \'single\'';
    const p = tmpFile(brief);
    const r = readTaskFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.content, brief);
});

test('readTaskFile: missing file is a clean error, not a throw', () => {
    const r = readTaskFile('/nonexistent/path/brief.md');
    assert.equal(r.ok, false);
    assert.match(r.error || '', /not found/);
});

test('readTaskFile: empty/whitespace-only file rejected', () => {
    const p = tmpFile('   \n\t\n');
    const r = readTaskFile(p);
    assert.equal(r.ok, false);
    assert.match(r.error || '', /empty/);
});

test('readTaskFile: oversize file rejected with actual size named', () => {
    const p = tmpFile('x'.repeat(2048));
    const r = readTaskFile(p, 1024);
    assert.equal(r.ok, false);
    assert.match(r.error || '', /too large: 2048 bytes/);
});

test('parseTaskTagsFlag: csv with spaces and case normalizes', () => {
    assert.deepEqual(parseTaskTagsFlag(' TDD, threat_model ,Security '), ['tdd', 'threat_model', 'security']);
});

test('parseTaskTagsFlag: empties dropped, absent flag yields []', () => {
    assert.deepEqual(parseTaskTagsFlag('a,,b,'), ['a', 'b']);
    assert.deepEqual(parseTaskTagsFlag(undefined), []);
    assert.deepEqual(parseTaskTagsFlag(''), []);
});
