import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { removeWidgetDir } from '../../src/core/widget-watcher.ts';
import { WIDGETS_DIR } from '../../src/core/config.ts';

test('removeWidgetDir removes the matching session widget directory', () => {
    const sessionId = 'delete-me';
    const sessionDir = join(WIDGETS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(join(sessionDir, 'chart.html'), '<h1>delete</h1>');

    removeWidgetDir(sessionId);

    assert.equal(fs.existsSync(sessionDir), false);
});

test('removeWidgetDir ignores missing widget directories', () => {
    assert.doesNotThrow(() => removeWidgetDir('already-missing'));
});
