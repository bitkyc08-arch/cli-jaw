import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const src = readFileSync(join(root, 'src/routes/code.ts'), 'utf8');

// Slice 210a: the Code workspace folder picker route is a Manager-local OS picker
// that returns only the chosen path and never mutates global project settings.

test('POST /api/code/workspace/pick is registered and backed by pickFolderNative', () => {
    assert.ok(src.includes("import { pickFolderNative } from '../core/folder-picker.js'"), 'must import pickFolderNative from folder-picker');
    assert.ok(src.includes("app.post('/api/code/workspace/pick', requireAuth,"), 'route must be registered with requireAuth');
    assert.ok(src.includes('await pickFolderNative('), 'route must call pickFolderNative');
});

test('workspace pick route maps every PickResult status and never mutates global settings', () => {
    // Isolate the route body so assertions are scoped to this handler.
    const start = src.indexOf("app.post('/api/code/workspace/pick'");
    assert.ok(start >= 0, 'route must exist');
    const body = src.slice(start, start + 900);

    assert.ok(body.includes("case 'picked':") && body.includes('ok: true, path:'), 'picked -> { ok, path }');
    assert.ok(body.includes("case 'cancelled':") && body.includes('cancelled: true'), 'cancelled -> { ok, cancelled }');
    assert.ok(body.includes("case 'busy':") && body.includes('status(409)'), 'busy -> 409');
    assert.ok(body.includes("case 'unavailable':") && body.includes('status(503)'), 'unavailable -> 503');

    assert.equal(body.includes('applySettings'), false, 'route must not call applySettings');
    assert.equal(body.includes('projectDirs'), false, 'route must not touch projectDirs');
});
