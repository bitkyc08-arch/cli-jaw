import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '..', '..');
const forbiddenPackages = [
    '@mdxeditor/editor',
    '@tiptap/',
    'lexical',
    '@lexical/',
    'remirror',
    '@remirror/',
    'blocknote',
    '@blocknote/',
    '@milkdown/crepe',
    '@milkdown/react',
    '@milkdown/plugin-math',
];

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function versionAtLeast(actual: string, minimum: string): boolean {
    const left = actual.split('.').map(Number);
    const right = minimum.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return true;
}

test('23.0 only adds approved Milkdown dependencies for true WYSIWYG editing', () => {
    const packageJson = read('package.json');
    const packageLock = read('package-lock.json');
    assert.ok(packageJson.includes('@milkdown/kit'), 'package.json must include Milkdown core kit');
    assert.ok(packageLock.includes('@milkdown/kit'), 'package-lock.json must include Milkdown core kit');
    for (const forbidden of forbiddenPackages) {
        assert.equal(packageJson.includes(forbidden), false, `package.json must not include ${forbidden}`);
        assert.equal(packageLock.includes(forbidden), false, `package-lock.json must not include ${forbidden}`);
    }
});

test('23.0 WYSIWYG source does not import editor dependencies', () => {
    const files = [
        'public/manager/src/notes/wysiwyg/wysiwyg-adapter-types.ts',
        'public/manager/src/notes/wysiwyg/markdown-roundtrip.ts',
        'public/manager/src/notes/wysiwyg/wysiwyg-fixtures.ts',
        'public/manager/src/notes/wysiwyg/wysiwyg-paste-policy.ts',
        'public/manager/src/notes/wysiwyg/wysiwyg-renderer-boundary.ts',
        'public/manager/src/notes/wysiwyg/MilkdownWysiwygEditor.tsx',
    ].map(read).join('\n');

    for (const forbidden of forbiddenPackages) {
        assert.equal(files.includes(forbidden), false, `WYSIWYG contracts must not import ${forbidden}`);
    }
});

test('Milkdown transitive ProseMirror model is pinned above the XSS advisory floor', () => {
    const packageLock = JSON.parse(read('package-lock.json')) as {
        packages?: Record<string, { version?: string }>;
    };
    const version = packageLock.packages?.['node_modules/prosemirror-model']?.version;
    assert.ok(version, 'package-lock must include prosemirror-model');
    assert.ok(versionAtLeast(version, '1.22.1'), `prosemirror-model must be >= 1.22.1, got ${version}`);
});
