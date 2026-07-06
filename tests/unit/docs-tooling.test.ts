// Phase 2A docs-tooling contract: checkDocs() compares live AST inventories
// against structure/*.md summary claims and reports drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs } from '../../scripts/docs/check-docs.mts';

test('DOCS-CHECK-001: checkDocs passes on current committed docs', async () => {
    const issues = await checkDocs();
    assert.deepEqual(issues, [], `expected no drift, got: ${JSON.stringify(issues)}`);
});

test('DOCS-CHECK-002: npm run docs:check script is wired', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['docs:check'], 'tsx scripts/docs/check-docs.mts');
});
