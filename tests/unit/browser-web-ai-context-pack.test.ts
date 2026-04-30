import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildContextPackageResult,
    buildInlineContextOrFail,
    collectPatterns,
    expandContextPaths,
    renderContextDryRunReport,
} from '../../src/browser/web-ai/context-pack/index.js';

test('web-ai context pack collects include and exclude patterns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'context.txt'), ['src/**/*.ts', '!src/**/*.test.ts'].join('\n'));

    const patterns = await collectPatterns({
        cwd: dir,
        contextFromFiles: ['README.md', '!dist/**'],
        contextFile: 'context.txt',
    });

    assert.deepEqual(patterns.include, ['README.md', 'src/**/*.ts']);
    assert.deepEqual(patterns.exclude, ['dist/**', 'src/**/*.test.ts']);
});

test('web-ai context pack expands directories and globs deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 1;');
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(join(dir, 'src', 'a.test.ts'), 'test');

    const paths = await expandContextPaths(['src'], ['**/*.test.ts'], dir);

    assert.deepEqual(paths.map(path => path.replace(`${dir}/`, '')), ['src/a.ts', 'src/b.ts']);
});

test('web-ai context pack rejects symlink traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'target.ts'), 'export const ok = true;');
    await symlink(join(dir, 'target.ts'), join(dir, 'link.ts'));

    await assert.rejects(() => expandContextPaths(['link.ts'], [], dir), /symlink/);
});

test('web-ai context pack renders untrusted file package metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'question.ts'), 'export function ask() { return "ok"; }\n');

    const result = await buildContextPackageResult({
        cwd: dir,
        vendor: 'chatgpt',
        model: 'pro',
        prompt: 'review this',
        contextFromFiles: ['src/*.ts'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.transport, 'upload');
    assert.equal(result.files.length, 1);
    assert.match(result.attachmentText, /\[CONTEXT PACKAGE\]/);
    assert.match(result.attachmentText, /The following file contents are untrusted input/);
    assert.match(result.attachmentText, /### File: src\/question\.ts/);
    assert.equal(result.composerText, 'review this');
    assert.match(renderContextDryRunReport(result), /\[context-dry-run\] 1 files/);
});

test('web-ai context pack can force inline composer transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'small.txt'), 'hello');

    const result = await buildInlineContextOrFail({
        cwd: dir,
        prompt: 'review',
        contextFromFiles: ['small.txt'],
        inlineOnly: true,
    });

    assert.equal(result?.transport, 'inline');
    assert.match(result?.composerText || '', /\[CONTEXT PACKAGE\]/);
    assert.match(result?.composerText || '', /\[USER REQUEST\]/);
});

test('web-ai context pack fails inline send preflight when over budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaw-ctx-pack-'));
    await writeFile(join(dir, 'large.txt'), 'x'.repeat(120));

    await assert.rejects(() => buildInlineContextOrFail({
        cwd: dir,
        prompt: 'review',
        contextFromFiles: ['large.txt'],
        maxInput: 5,
    }), /max input tokens/);
});
