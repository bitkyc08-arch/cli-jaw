import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { BoardStore } from '../../src/manager/board/store.js';

test('BoardStore persists editable title, summary, and markdown detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-board-'));
    try {
        const store = new BoardStore({ dbPath: join(dir, 'dashboard.db') });
        const created = store.create({
            title: 'Initial title',
            summary: 'One-line memo',
            detail: '## Details\n\n- markdown item',
            lane: 'inbox',
        });

        assert.equal(created.title, 'Initial title');
        assert.equal(created.summary, 'One-line memo');
        assert.equal(created.detail, '## Details\n\n- markdown item');

        const updated = store.update(created.id, {
            title: 'Updated title',
            summary: 'Updated memo',
            detail: '### Updated\n\nFull text',
        });

        assert.equal(updated?.title, 'Updated title');
        assert.equal(updated?.summary, 'Updated memo');
        assert.equal(updated?.detail, '### Updated\n\nFull text');
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
