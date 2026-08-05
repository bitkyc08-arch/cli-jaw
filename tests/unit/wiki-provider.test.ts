import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldWikiVault } from '../../src/wiki/scaffold.ts';
import { assertUsableWikiRoot } from '../../src/wiki/config.ts';
import { WikiSearchProvider, WIKI_SEARCH_RESULT_CAP } from '../../src/search/providers/wiki.ts';
import type { SearchQuery } from '../../src/search/contract.ts';

function tempRoot(): string {
    return join(mkdtempSync(join(tmpdir(), 'jaw-wiki-prov-')), 'vault');
}

const query = (text: string): SearchQuery => ({ query: text, corpus: 'wiki' });
const opts = (limit = 10, offset = 0) => ({ limit, offset });

// 040 §12 criterion 1 — a disabled vault answers without touching the filesystem.
test('a disabled provider reports off and reads nothing', async () => {
    let read = false;
    const provider = new WikiSearchProvider(() => {
        read = true;
        return { enabled: false, root: '/nonexistent/vault', promptDigest: false };
    });

    assert.equal(provider.status(), 'off');
    const result = await provider.search(query('anything'), opts());
    assert.deepEqual(result.groups[0]?.hits, []);
    assert.equal(result.warnings[0]?.code, 'provider_off');
    assert.equal(result.providers[0]?.status, 'off');
    assert.ok(read, 'the config is consulted');
});

// An enabled vault that has gone missing is an error, not silence: the user asked for it.
test('an enabled provider whose vault is gone reports a failure', async () => {
    const provider = new WikiSearchProvider(() => ({
        enabled: true, root: join(tmpdir(), 'jaw-wiki-does-not-exist'), promptDigest: false,
    }));

    assert.equal(provider.status(), 'error');
    const result = await provider.search(query('anything'), opts());
    assert.equal(result.warnings[0]?.code, 'provider_failed');
    assert.equal(result.providers[0]?.status, 'error');
});

test('an enabled vault returns hits located by path and line', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    writeFileSync(join(root, 'entities/people/ada.md'), '# Ada Lovelace\n\nfirst programmer\n', 'utf8');
    const provider = new WikiSearchProvider(() => ({ enabled: true, root, promptDigest: false }));

    assert.equal(provider.status(), 'ready');
    const result = await provider.search(query('Lovelace'), opts());
    const hit = result.groups[0]?.hits[0];
    assert.ok(hit, 'the entity page is found');
    assert.equal(hit.corpus, 'wiki');
    assert.equal(hit.provider, 'local-wiki');
    assert.equal(hit.location?.path, 'entities/people/ada.md');
    assert.ok(typeof hit.location?.startLine === 'number');
});

// The wiki is shared, so a session filter cannot narrow it. Saying so is better than
// silently returning results the caller believes are session-scoped.
test('a session filter is reported as ignored rather than silently dropped', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    writeFileSync(join(root, 'concepts/topic.md'), '# Topic\n\nsomething findable\n', 'utf8');
    const provider = new WikiSearchProvider(() => ({ enabled: true, root, promptDigest: false }));

    const result = await provider.search({ ...query('findable'), sessionFilter: 'sess-1' }, opts());
    assert.ok(result.warnings.some(w => w.code === 'session_filter_ignored'));
});

// 040 §0c R3 — the shared note search refuses a request past its cap, so asking for one
// more row than the page needs must never exceed it.
test('paging never asks the shared search for more than it accepts', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(root, `concepts/page-${i}.md`), `# Page ${i}\n\nrepeated marker\n`, 'utf8');
    }
    const provider = new WikiSearchProvider(() => ({ enabled: true, root, promptDigest: false }));

    // A page deep enough that offset + limit + 1 would exceed the cap.
    const deep = await provider.search(query('marker'), { limit: 20, offset: WIKI_SEARCH_RESULT_CAP - 10 });
    assert.deepEqual(deep.groups[0]?.hits, [], 'past the cap there is nothing left, and no throw');
    assert.equal(deep.page.hasMore, false);
});

test('a page reports more only when there is more', async () => {
    const root = tempRoot();
    await scaffoldWikiVault(root);
    for (let i = 0; i < 4; i += 1) {
        writeFileSync(join(root, `concepts/multi-${i}.md`), `# Multi ${i}\n\nshared token\n`, 'utf8');
    }
    const provider = new WikiSearchProvider(() => ({ enabled: true, root, promptDigest: false }));

    const first = await provider.search(query('shared token'), opts(2, 0));
    assert.equal(first.groups[0]?.hits.length, 2);
    assert.equal(first.page.hasMore, true);

    const last = await provider.search(query('shared token'), opts(2, 2));
    assert.equal(last.page.hasMore, false, 'the final page does not claim another');
});

// 040 §0c R2 — the vault must not be pointed at the notes root in either direction.
test('a root colliding with another vault is refused', () => {
    const notes = join(tmpdir(), 'jaw-notes-root');
    assert.throws(() => assertUsableWikiRoot(notes, [notes]), /collides/);
    assert.throws(() => assertUsableWikiRoot(join(notes, 'inner'), [notes]), /collides/);
    assert.throws(() => assertUsableWikiRoot(notes, [join(notes, 'inner')]), /collides/, 'containing it is also a collision');
    assert.doesNotThrow(() => assertUsableWikiRoot(join(tmpdir(), 'jaw-wiki-elsewhere'), [notes]));
    assert.doesNotThrow(() => assertUsableWikiRoot(join(tmpdir(), 'jaw-wiki-elsewhere'), []));
});

// An alias reaching the forbidden root through a symlink is the same directory by every
// meaning except its spelling, so a lexical comparison would let it through.
test('a forbidden root reached through a symlink is still refused', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const { mkdtempSync } = await import('node:fs');
    const base = mkdtempSync(join(tmpdir(), 'jaw-wiki-forbidden-'));
    const notes = join(base, 'notes');
    mkdirSync(notes);
    const alias = join(base, 'alias');
    symlinkSync(notes, alias);

    assert.throws(() => assertUsableWikiRoot(alias, [notes]), /collides/);
    assert.throws(() => assertUsableWikiRoot(notes, [alias]), /collides/, 'and in the other direction');
});
