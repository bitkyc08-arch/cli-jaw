import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeResolveUnder } from '../../src/security/path-guards.js';

test('safeResolveUnder: symlink/junction escape rejected, internal links allowed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-guard-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-guard-out-'));
    try {
        fs.symlinkSync(outside, path.join(root, 'link'));
        assert.throws(() => safeResolveUnder(root, 'link'), /path_escape/);

        fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'filelink'));
        assert.throws(() => safeResolveUnder(root, 'filelink'), /path_escape/);

        fs.mkdirSync(path.join(root, 'sub'));
        fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inlink'));
        assert.ok(safeResolveUnder(root, 'inlink').endsWith('inlink'));

        // not-yet-existing target: canonical parent + basename, still contained
        assert.ok(safeResolveUnder(root, 'new.txt').endsWith('new.txt'));

        // plain lexical escape still rejected
        assert.throws(() => safeResolveUnder(root, '../x'), /path_escape/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
