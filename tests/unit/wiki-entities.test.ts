// The scanner's job is to be hard to trick, so these drive the tricks: links where files
// should be, roots that move under the walk, files that vanish mid-read, and enough small
// files to slip past a per-file cap. A guard nobody has seen fire is not a guard.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { settings } from '../../src/core/config.ts';
import { isWikiEnabled, storedWikiRoot } from '../../src/wiki/config.ts';
import {
    scanVaultFiles,
    MAX_ENTITY_DEPTH,
    MAX_ENTITY_FILE_BYTES,
    type ScanDeps,
} from '../../src/wiki/safe-traversal.ts';
import { buildEntityIndex } from '../../src/wiki/entities.ts';
import * as realFs from 'node:fs';

function freshVault(): string {
    // realpath because macOS hands out /var symlinks for temp dirs, and the anchor check
    // would rightly refuse one.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cxc-wiki-')));
    mkdirSync(join(root, 'entities'), { recursive: true });
    return root;
}

function useVault(root: string, enabled = true): void {
    settings["wiki"] = { enabled, root, promptDigest: false };
}

function note(root: string, rel: string, body: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
}

const entityNote = (kind: string, id: string) => `---\nentity:\n  kind: ${kind}\n  id: ${id}\n---\n\nbody\n`;

// ─── ENT-1: a disabled vault is never touched ───

test('ENT-1: a disabled vault draws no filesystem calls at all', () => {
    const root = freshVault();
    note(root, 'entities/ada.md', entityNote('person', 'ada'));
    useVault(root, false);

    const calls: string[] = [];
    const watched = new Proxy({} as ScanDeps, {
        get(_t, prop: string) {
            return (...args: unknown[]) => {
                calls.push(prop);
                return (realFs as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!(...args);
            };
        },
    });

    const index = buildEntityIndex(watched);
    assert.equal(index.status, 'off');
    assert.deepEqual(calls, [], 'the root exists, so an empty call list means it was never consulted');
    assert.deepEqual(index.entities, []);
});

test('ENT-1b: the enabled check answers without resolving the root', () => {
    const root = freshVault();
    useVault(root, false);
    assert.equal(isWikiEnabled(), false);
    useVault(root, true);
    assert.equal(isWikiEnabled(), true);
});

// ─── ENT-2: links and hardlinks ───

test('ENT-2: a symlinked note is skipped, not followed', () => {
    const root = freshVault();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cxc-outside-')));
    writeFileSync(join(outside, 'secret.md'), entityNote('person', 'leaked'));
    note(root, 'entities/real.md', entityNote('person', 'real'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'entities/link.md'));
    useVault(root);

    const scan = scanVaultFiles(storedWikiRoot());
    assert.ok(scan.ok);
    assert.ok(scan.ok && scan.files.every(f => !f.text.includes('leaked')), 'the link never yields its target');
    assert.ok(scan.ok && scan.skipped.some(s => s.reason === 'symlink'));
});

test('ENT-2c: a hardlink is refused because no path check can see it', () => {
    const root = freshVault();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cxc-outside-')));
    const target = join(outside, 'secret.md');
    writeFileSync(target, entityNote('person', 'leaked'));
    linkSync(target, join(root, 'entities/hard.md'));
    useVault(root);

    const scan = scanVaultFiles(storedWikiRoot());
    assert.ok(scan.ok);
    assert.ok(scan.ok && scan.skipped.some(s => s.reason === 'hardlink'));
    assert.ok(scan.ok && scan.files.length === 0);
});

// ─── ENT-3: the limits actually bind ───

test('ENT-3b: the walk stops descending past the depth limit', () => {
    const root = freshVault();
    const deep = Array.from({ length: MAX_ENTITY_DEPTH + 3 }, (_, i) => `d${i}`).join('/');
    note(root, `${deep}/buried.md`, entityNote('person', 'buried'));
    note(root, 'entities/shallow.md', entityNote('person', 'shallow'));
    useVault(root);

    const scan = scanVaultFiles(storedWikiRoot());
    assert.ok(scan.ok);
    assert.ok(scan.ok && scan.truncated, 'going too deep marks the result partial');
});

test('ENT-3c: a file past the per-file cap is skipped, the rest survive', () => {
    const root = freshVault();
    note(root, 'entities/huge.md', 'x'.repeat(MAX_ENTITY_FILE_BYTES + 1024));
    note(root, 'entities/ada.md', entityNote('person', 'ada'));
    useVault(root);

    const scan = scanVaultFiles(storedWikiRoot());
    assert.ok(scan.ok);
    assert.ok(scan.ok && scan.skipped.some(s => s.reason === 'too_large' && s.relPath.endsWith('huge.md')));
    assert.ok(scan.ok && scan.files.some(f => f.relPath.endsWith('ada.md')));
});

// ─── ENT-4: the root anchor ───

test('ENT-4c: a missing root is a scan error, not an empty result', () => {
    useVault(join(tmpdir(), 'cxc-wiki-does-not-exist-9137'));
    const scan = scanVaultFiles(storedWikiRoot());
    assert.equal(scan.ok, false);
    assert.ok(!scan.ok && scan.error === 'root_missing');
});

test('ENT-4d: a root that is itself a symlink is refused before anything is read', () => {
    const real = freshVault();
    note(real, 'entities/ada.md', entityNote('person', 'ada'));
    const linkRoot = join(realpathSync(mkdtempSync(join(tmpdir(), 'cxc-link-'))), 'vault');
    symlinkSync(real, linkRoot);
    useVault(linkRoot);

    const scan = scanVaultFiles(storedWikiRoot());
    assert.equal(scan.ok, false, 'a linked root cannot anchor the walk');
    assert.ok(!scan.ok && scan.error === 'root_symlink');
});

test('ENT-4d2: a root swapped mid-walk discards what was collected', () => {
    const root = freshVault();
    note(root, 'entities/a.md', entityNote('person', 'a'));
    note(root, 'entities/b.md', entityNote('person', 'b'));
    useVault(root);

    // Report the truth until the walk has begun, then claim the root resolves elsewhere,
    // which is what a swap looks like from inside the scan.
    let resolves = 0;
    const shifting: ScanDeps = {
        ...realFs,
        realpathSync: ((p: string) => {
            resolves += 1;
            const truth = realFs.realpathSync(p);
            return resolves > 2 && p === root ? join(root, 'entities') : truth;
        }) as typeof realFs.realpathSync,
    } as ScanDeps;

    const scan = scanVaultFiles(storedWikiRoot(), shifting);
    assert.equal(scan.ok, false, 'a moved root fails the scan');
    assert.ok(!scan.ok && scan.error === 'root_moved');
});

test('ENT-4d3: the stored root is lexical, so the anchor is not compared with itself', () => {
    const real = freshVault();
    const linkRoot = join(realpathSync(mkdtempSync(join(tmpdir(), 'cxc-link2-'))), 'vault');
    symlinkSync(real, linkRoot);
    useVault(linkRoot);
    assert.equal(storedWikiRoot(), linkRoot, 'the setting is echoed back, not resolved');
    assert.notEqual(storedWikiRoot(), real, 'resolving here would make the anchor check vacuous');
});

test('ENT-4d4: a root already pointing elsewhere at the first look fails immediately', () => {
    const root = freshVault();
    note(root, 'entities/a.md', entityNote('person', 'a'));
    useVault(root);

    // Every resolve disagrees with the stored path, which is what an already-swapped root
    // looks like. This has to be caught by the opening anchor rather than the re-checks,
    // so the walk never reads a single entry.
    let readdirCalls = 0;
    const alreadyMoved: ScanDeps = {
        ...realFs,
        realpathSync: ((p: string) => (p === root ? join(root, 'entities') : realFs.realpathSync(p))) as typeof realFs.realpathSync,
        readdirSync: ((p: string, o: unknown) => {
            readdirCalls += 1;
            return (realFs.readdirSync as unknown as (a: string, b: unknown) => unknown)(p, o);
        }) as typeof realFs.readdirSync,
    } as ScanDeps;

    const scan = scanVaultFiles(storedWikiRoot(), alreadyMoved);
    assert.equal(scan.ok, false);
    assert.ok(!scan.ok && scan.error === 'root_moved');
    assert.equal(readdirCalls, 0, 'nothing is read from a root that already moved');
});

test('ENT-4b: a note deleted mid-scan is skipped rather than throwing', () => {
    const root = freshVault();
    note(root, 'entities/gone.md', entityNote('person', 'gone'));
    note(root, 'entities/stays.md', entityNote('person', 'stays'));
    useVault(root);

    const vanishing: ScanDeps = {
        ...realFs,
        openSync: ((p: string, flags: number) => {
            if (String(p).endsWith('gone.md')) {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
            return realFs.openSync(p, flags);
        }) as typeof realFs.openSync,
    } as ScanDeps;

    const scan = scanVaultFiles(storedWikiRoot(), vanishing);
    assert.ok(scan.ok, 'one vanishing file does not end the walk');
    assert.ok(scan.ok && scan.files.some(f => f.relPath.endsWith('stays.md')));
    assert.ok(scan.ok && scan.skipped.some(s => s.relPath.endsWith('gone.md')));
});

// ─── ENT-6/7: parse failures stay apart from ontology complaints ───

test('ENT-6: broken YAML is reported separately and does not stop the scan', () => {
    const root = freshVault();
    note(root, 'entities/broken.md', '---\nentity: [unclosed\n---\nbody\n');
    note(root, 'entities/ada.md', entityNote('person', 'ada'));
    useVault(root);

    const index = buildEntityIndex();
    assert.equal(index.status, 'ok');
    assert.equal(index.parseWarnings.length, 1);
    assert.equal(index.parseWarnings[0]?.code, 'frontmatter_parse_failed');
    assert.deepEqual(index.ontologyWarnings, [], 'a malformed file is not also an ontology complaint');
    assert.equal(index.entities.length, 1, 'the readable note still indexes');
});

test('ENT-7: an ordinary note without frontmatter is silent', () => {
    const root = freshVault();
    note(root, 'entities/plain.md', '# just a note\n\nnothing structured here\n');
    useVault(root);

    const index = buildEntityIndex();
    assert.equal(index.status, 'ok');
    assert.deepEqual(index.entities, []);
    assert.deepEqual(index.parseWarnings, []);
    assert.deepEqual(index.ontologyWarnings, []);
});

test('ENT-6b: an unknown kind is an ontology complaint, not a parse failure', () => {
    const root = freshVault();
    note(root, 'entities/org.md', entityNote('organisation', 'acme'));
    useVault(root);

    const index = buildEntityIndex();
    assert.deepEqual(index.parseWarnings, []);
    assert.equal(index.ontologyWarnings.length, 1);
    assert.equal(index.ontologyWarnings[0]?.code, 'invalid_entity_kind');
});

test('the index reads relations off a well-formed note', () => {
    const root = freshVault();
    note(root, 'entities/ada.md',
        '---\nentity:\n  kind: person\n  id: ada\nrelations:\n  - type: works-on\n    target: jaw\n---\n');
    useVault(root);

    const index = buildEntityIndex();
    assert.equal(index.entities.length, 1);
    assert.deepEqual(index.entities[0]?.entity, { kind: 'person', id: 'ada' });
    assert.deepEqual(index.entities[0]?.relations, [{ type: 'works-on', target: 'jaw' }]);
});
