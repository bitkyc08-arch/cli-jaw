import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const route = readFileSync(join(root, 'src/routes/bgtask.ts'), 'utf8');

test('bgtask routes publish additive shared status category in public task payloads', () => {
    assert.match(route, /function toPublicTask\(task: BgTaskRow\)/);
    assert.match(route, /statusCategory: normalizeBgTaskStatus\(task\.status\)/);
    assert.match(route, /tasks\.map\(toPublicTask\)/);
    assert.match(route, /res\.json\(\{ task: toPublicTask\(task\) \}\)/);
    assert.match(route, /task: toPublicTask\(row\)/);
    assert.match(route, /next \? toPublicTask\(next\) : null/);
});
