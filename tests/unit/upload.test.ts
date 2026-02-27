// #42: upload.ts unit tests — saveUpload filename handling
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveUpload } from '../../lib/upload.ts';

const tmpDir = () => {
    const d = path.join(os.tmpdir(), `upload-test-${Date.now()}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

test('UP-001: saveUpload preserves .ipynb extension', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('{}'), 'notebook.ipynb');
    assert.ok(p.endsWith('.ipynb'));
    fs.rmSync(dir, { recursive: true });
});

test('UP-002: saveUpload preserves Korean filename stem', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('data'), '한글파일.xlsx');
    assert.ok(path.basename(p).includes('한글파일'), `expected Korean stem in: ${p}`);
    fs.rmSync(dir, { recursive: true });
});

test('UP-003: saveUpload falls back to "file" on empty stem', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('x'), '!!!.bin');
    assert.ok(path.basename(p).includes('file'), `expected 'file' fallback in: ${p}`);
    fs.rmSync(dir, { recursive: true });
});

test('UP-004: saveUpload defaults to .bin when no extension', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('x'), 'noext');
    assert.ok(p.endsWith('.bin'));
    fs.rmSync(dir, { recursive: true });
});
