import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import {
    DEFAULT_WIKI_CONFIG,
    normalizeWikiConfig,
    readWikiConfig,
    wikiProviderStatus,
    writeWikiConfig,
    WIKI_REQUIRED_DIRS,
    WIKI_REQUIRED_FILES,
} from '../../src/wiki/config.ts';
import { scaffoldWikiVault } from '../../src/wiki/scaffold.ts';

const roots: string[] = [];
function tempRoot(): string {
    const root = join(mkdtempSync(join(tmpdir(), 'jaw-wiki-')), 'vault');
    roots.push(root);
    return root;
}

afterEach(async () => {
    await writeWikiConfig(normalizeWikiConfig(DEFAULT_WIKI_CONFIG));
});

// 040 §3 — the vault is off by default and nothing exists on disk until it is enabled.

test('the default configuration is disabled and creates nothing', () => {
    const config = readWikiConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.promptDigest, false);
    assert.equal(config.root, join(homedir(), 'jaw-wiki'), 'the tilde is expanded to an absolute path');
});

test('the configuration survives a write and read round trip through settings', async () => {
    const root = tempRoot();
    await writeWikiConfig(normalizeWikiConfig({ enabled: true, root, promptDigest: true }));

    const readBack = readWikiConfig();
    assert.equal(readBack.enabled, true);
    assert.equal(readBack.promptDigest, true);
    assert.equal(readBack.root, root);
});

// A root that is the filesystem root, or empty, makes every path guard meaningless and
// would scatter a scaffold across the whole disk.
test('an unusable root is rejected rather than normalised into something dangerous', () => {
    assert.throws(() => normalizeWikiConfig({ root: '' }), /invalid settings.wiki.root/);
    assert.throws(() => normalizeWikiConfig({ root: '   ' }), /invalid settings.wiki.root/);
    assert.throws(() => normalizeWikiConfig({ root: parse(process.cwd()).root }), /invalid settings.wiki.root/);
});

test('anything other than a literal true reads as off', () => {
    for (const value of [undefined, null, 'true', 1, {}]) {
        const config = normalizeWikiConfig({ root: '/tmp/x', enabled: value as never, promptDigest: value as never });
        assert.equal(config.enabled, false, `${String(value)} must not enable the vault`);
        assert.equal(config.promptDigest, false);
    }
});

// 040 §12 criterion 1 — a disabled vault reports off even when its files are present.
test('status is off while disabled, whatever is on disk', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    assert.equal(wikiProviderStatus({ enabled: false, root, promptDigest: false }), 'off');
});

test('status is ready once an enabled vault has its full layout', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'ready');
});

test('an enabled vault that is missing or renamed reports error, not off', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    const moved = `${root}-moved`;
    renameSync(root, moved);
    roots.push(moved);
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'error');

    renameSync(moved, root);
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'ready', 'and it recovers');
});

test('a vault missing any required directory or file is an error', async () => {
    for (const missing of [...WIKI_REQUIRED_DIRS, ...WIKI_REQUIRED_FILES]) {
        const root = tempRoot();
        await scaffoldWikiVault(root);
        renameSync(join(root, missing), join(root, `${missing.replace(/\//g, '-')}-hidden`));
        assert.equal(
            wikiProviderStatus({ enabled: true, root, promptDigest: false }),
            'error',
            `${missing} is required for readiness`,
        );
    }
});

// A symlink pointing outside the vault must not pass as the real thing.
test('a required directory replaced by a symlink is not accepted', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    const elsewhere = tempRoot();
    mkdirSync(elsewhere, { recursive: true });
    const concepts = join(root, 'concepts');
    renameSync(concepts, join(root, 'concepts-real'));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(elsewhere, concepts);
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'error');
});

test('a required file replaced by a directory is not accepted', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    const wikiFile = join(root, 'WIKI.md');
    renameSync(wikiFile, join(root, 'WIKI-real.md'));
    mkdirSync(wikiFile);
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'error');
});

test('scaffolding a vault twice leaves existing content untouched', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);

    const userFile = join(root, 'inbox.md');
    writeFileSync(userFile, '# my own notes\n', 'utf8');
    const seedFile = join(root, 'WIKI.md');
    writeFileSync(seedFile, '# edited by the user\n', 'utf8');

    await scaffoldWikiVault(root);

    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(userFile, 'utf8'), '# my own notes\n', 'a rewritten seed file must survive');
    assert.equal(readFileSync(seedFile, 'utf8'), '# edited by the user\n');
    assert.equal(wikiProviderStatus({ enabled: true, root, promptDigest: false }), 'ready');
});

test('scaffolding into a directory that already holds notes keeps them', async () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const existing = join(root, 'existing.md');
    writeFileSync(existing, '# pre-existing\n', 'utf8');

    await scaffoldWikiVault(root);

    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(existing, 'utf8'), '# pre-existing\n');
});

// resolve() turns '.', '..' and any relative path into an absolute one, so validating
// after resolution always passes and an empty or relative root would be scaffolded
// relative to wherever the process happens to be running.
test('a relative root is rejected rather than resolved against the working directory', () => {
    for (const root of ['.', '..', 'notes', './notes', '../elsewhere']) {
        assert.throws(
            () => normalizeWikiConfig({ root }),
            /must be absolute/,
            `${root} must not be silently made absolute`,
        );
    }
});

// A directory inside the vault that is really a symlink would place vault files
// somewhere the user never chose. The scaffold checks before it writes, not after.
test('scaffolding refuses to write through a symlinked directory inside the vault', async () => {
    const { symlinkSync, mkdirSync: mkdirs } = await import('node:fs');
    const root = tempRoot();
    const outside = tempRoot();
    mkdirs(outside, { recursive: true });
    mkdirs(root, { recursive: true });
    symlinkSync(outside, join(root, 'concepts'));

    await assert.rejects(scaffoldWikiVault(root), /escapes its root|is a symlink/);

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(outside, 'compiled-digest.md')), false, 'nothing was written outside the vault');
});

test('scaffolding refuses to write through a symlinked seed file', async () => {
    const { symlinkSync, mkdirSync: mkdirs, writeFileSync: write, existsSync } = await import('node:fs');
    const root = tempRoot();
    const outside = tempRoot();
    mkdirs(outside, { recursive: true });
    const decoy = join(outside, 'decoy.md');
    write(decoy, 'original\n', 'utf8');
    await scaffoldWikiVault(root);

    const { rmSync } = await import('node:fs');
    rmSync(join(root, 'inbox.md'));
    symlinkSync(decoy, join(root, 'inbox.md'));

    await assert.rejects(scaffoldWikiVault(root), /escapes its root|is a symlink/);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(decoy, 'utf8'), 'original\n', 'the file outside the vault is untouched');
    assert.ok(existsSync(decoy));
});

// The route always writes a complete object, so it cannot show whether the wiki block is
// in the nested-merge list. This aims at that list directly: without it a partial patch
// REPLACES the block, silently dropping the root and the enabled flag alongside whatever
// single field the caller meant to change.
test('a partial settings patch preserves the wiki fields it does not mention', async () => {
    const root = tempRoot();
    await writeWikiConfig(normalizeWikiConfig({ enabled: true, root, promptDigest: false }));

    const { applyRuntimeSettingsPatch } = await import('../../src/core/runtime-settings.ts');
    await applyRuntimeSettingsPatch({ wiki: { promptDigest: true } });

    const after = readWikiConfig();
    assert.equal(after.promptDigest, true, 'the patched field changed');
    assert.equal(after.enabled, true, 'and the untouched flag survived');
    assert.equal(after.root, root, 'as did the root');
});

// "Creates nothing" has to be observed on disk, not inferred from the setting.
test('reading the configuration never creates the vault it names', async () => {
    const root = tempRoot();
    await writeWikiConfig(normalizeWikiConfig({ enabled: false, root, promptDigest: false }));

    const { existsSync } = await import('node:fs');
    assert.equal(readWikiConfig().root, root);
    assert.equal(wikiProviderStatus(readWikiConfig()), 'off');
    assert.equal(existsSync(root), false, 'nothing was created by reading');
});

// Pinning the root canonically depends on the directory existing, which it does not when
// a vault is first configured. These pin the two halves of that: a path that is not there
// yet normalises unchanged, and one that is gets resolved.
test('a root that does not exist yet normalises without being resolved away', () => {
    const notYet = join(tempRoot(), 'never', 'made');
    assert.equal(normalizeWikiConfig({ root: notYet }).root, notYet);
});

test('an existing root is pinned to its canonical form', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    const { realpathSync } = await import('node:fs');
    assert.equal(normalizeWikiConfig({ root }).root, realpathSync(root));
});

// And a configuration written before the vault existed keeps working once it does, since
// the uncanonical path still names the same directory.
test('a config written before the vault existed still reports ready afterwards', async () => {
    const root = tempRoot();
    const early = normalizeWikiConfig({ enabled: true, root, promptDigest: false });
    await scaffoldWikiVault(early.root);
    assert.equal(wikiProviderStatus(early), 'ready');
});

test('the tilde still expands to the home directory', () => {
    assert.equal(normalizeWikiConfig({ root: '~/jaw-wiki' }).root, join(homedir(), 'jaw-wiki'));
});
