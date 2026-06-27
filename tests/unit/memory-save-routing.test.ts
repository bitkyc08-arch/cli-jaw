import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, read, save } from '../../src/memory/memory.ts';

test('memory save writes explicit structured paths under memory root', () => {
    const target = 'structured/episodes/live/2099-01-02.md';
    const savedPath = save(target, 'structured episode contract');
    assert.equal(savedPath, path.join(MEMORY_DIR, target));
    assert.ok(read(target)?.includes('structured episode contract'));
});

test('memory save rejects episode path escape attempts', () => {
    assert.throws(
        () => save('../../escape.md', 'nope'),
        /memory_path_out_of_root/,
    );
});

test('memory save keeps legacy filename compatibility', () => {
    const target = `legacy-${Date.now()}.md`;
    const savedPath = save(target, 'legacy compatibility contract');
    assert.equal(savedPath, path.join(MEMORY_DIR, target));
    assert.ok(fs.existsSync(savedPath));
    assert.ok(read(target)?.includes('legacy compatibility contract'));
});
