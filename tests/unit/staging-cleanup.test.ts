import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { cleanupStaleStaging, listStaleStaging } = require_('../../scripts/staging-cleanup.cjs') as {
    cleanupStaleStaging(nodeModulesDir: string, deps?: Record<string, unknown>): { removed: string[]; skipped: string[] };
    listStaleStaging(nodeModulesDir: string, deps?: Record<string, unknown>): string[];
};

function fixture(names: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-staging-'));
    for (const name of names) fs.mkdirSync(path.join(root, name), { recursive: true });
    return root;
}

function deps(overrides: Record<string, unknown> = {}) {
    return {
        rm: () => {},
        rename: () => {},
        readName: () => 'cli-jaw',
        probeOpen: () => {},
        walkFiles: (dir: string) => [path.join(dir, 'package.json'), path.join(dir, 'dist.js')],
        readLedger: () => [],
        writeLedger: () => {},
        log: () => {},
        ...overrides,
    };
}

test('locked file skips the whole candidate without rename or rm', () => {
    const root = fixture(['.cli-jaw-locked']);
    let renamed = 0;
    let removed = 0;
    const result = cleanupStaleStaging(root, deps({
        probeOpen: (file: string) => {
            if (file.endsWith('dist.js')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        rename: () => { renamed += 1; },
        rm: () => { removed += 1; },
    }));
    assert.deepEqual(result, { removed: [], skipped: ['.cli-jaw-locked'] });
    assert.equal(renamed, 0);
    assert.equal(removed, 0);
});

test('fresh candidate orders probe, ledger, rename, then rm', () => {
    const root = fixture(['.cli-jaw-fresh']);
    const calls: string[] = [];
    const result = cleanupStaleStaging(root, deps({
        walkFiles: () => ['one'],
        probeOpen: () => calls.push('probe'),
        writeLedger: () => calls.push('ledger'),
        rename: () => calls.push('rename'),
        rm: () => calls.push('rm'),
    }));
    assert.deepEqual(result, { removed: ['.cli-jaw-fresh'], skipped: [] });
    assert.deepEqual(calls.slice(0, 4), ['probe', 'ledger', 'rename', 'rm']);
});

test('name mismatch and non-matching directories remain untouched', () => {
    const root = fixture(['.cli-jaw-other', 'cli-jaw-normal']);
    let mutations = 0;
    const injected = deps({
        readName: () => 'another-package',
        rename: () => { mutations += 1; },
        rm: () => { mutations += 1; },
    });
    assert.deepEqual(listStaleStaging(root, injected), []);
    assert.deepEqual(cleanupStaleStaging(root, injected), { removed: [], skipped: [] });
    assert.equal(mutations, 0);
});

test('rename failure never calls rm', () => {
    const root = fixture(['.cli-jaw-rename']);
    let removed = 0;
    const result = cleanupStaleStaging(root, deps({
        rename: () => { throw new Error('rename failed'); },
        rm: () => { removed += 1; },
    }));
    assert.deepEqual(result, { removed: [], skipped: ['.cli-jaw-rename'] });
    assert.equal(removed, 0);
});

test('rm failure leaves ledger-backed deleting candidate for retry', () => {
    const root = fixture(['.cli-jaw-rm']);
    const ledgers: Array<Array<{ dir: string }>> = [];
    const result = cleanupStaleStaging(root, deps({
        writeLedger: (_file: string, entries: Array<{ dir: string }>) => ledgers.push(structuredClone(entries)),
        rename: (from: string, to: string) => fs.renameSync(from, to),
        rm: () => { throw new Error('rm failed'); },
    }));
    assert.deepEqual(result, { removed: [], skipped: ['.cli-jaw-rm.deleting'] });
    assert.equal(fs.existsSync(path.join(root, '.cli-jaw-rm.deleting')), true);
    assert.equal(ledgers.at(-1)?.[0]?.dir, '.cli-jaw-rm.deleting');
});

test('ledger-less deleting directory is untouched', () => {
    const root = fixture(['.cli-jaw-old.deleting']);
    let removed = 0;
    const injected = deps({ rm: () => { removed += 1; } });
    assert.deepEqual(listStaleStaging(root, injected), []);
    assert.deepEqual(cleanupStaleStaging(root, injected), { removed: [], skipped: [] });
    assert.equal(removed, 0);
});

test('ledger-backed deleting directory is retried', () => {
    const root = fixture(['.cli-jaw-old.deleting']);
    const calls: string[] = [];
    const ledger = [{ dir: '.cli-jaw-old.deleting', verifiedName: 'cli-jaw', renamedAt: 'now' }];
    const result = cleanupStaleStaging(root, deps({
        readLedger: () => ledger,
        writeLedger: () => calls.push('ledger'),
        rm: (target: string) => calls.push(`rm:${path.basename(target)}`),
    }));
    assert.deepEqual(result, { removed: ['.cli-jaw-old.deleting'], skipped: [] });
    assert.deepEqual(calls, ['rm:.cli-jaw-old.deleting', 'ledger']);
});
