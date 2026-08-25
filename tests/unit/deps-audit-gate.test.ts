import '../setup/isolated-home.ts';
// #460: the old "Deps security check" compared three hardcoded version rules
// (ws, node-fetch x2) and reported PASS for everything else, so the mermaid
// prototype pollution of #456 cleared CI and sat in dev. These pin the shape of
// the replacement: every advisory needs a recorded decision, and the decision
// has to say something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const allowlist = JSON.parse(
    readFileSync(join(root, 'scripts/audit-allowlist.json'), 'utf8'),
) as { allow: Array<{ package: string; severity: string; reason: string; review: string }> };

test('DAG-001: every allowlist entry carries a reachability reason and a review date', () => {
    assert.ok(allowlist.allow.length > 0, 'an empty allowlist would mean nothing was ever examined');
    for (const entry of allowlist.allow) {
        assert.ok(entry.package, 'entry needs a package');
        assert.match(entry.review, /^\d{4}-\d{2}-\d{2}$/, `${entry.package}: review must be a date`);
        // A reason short enough to be "low severity" or "dev only" is not a
        // reachability analysis. The entry has to name why the path is absent.
        assert.ok(entry.reason.length >= 60,
            `${entry.package}: reason must explain why the vulnerable path is unreachable here`);
    }
});

test('DAG-002: package names are unique so one entry cannot silently shadow another', () => {
    const names = allowlist.allow.map(e => e.package);
    assert.deepEqual(names.length, new Set(names).size, 'duplicate package entries');
});

test('DAG-003: CI runs the gate, and package.json exposes it', () => {
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    assert.ok(workflow.includes('npm run check:deps:audit'),
        'the gate must run in CI — a script nobody calls catches nothing');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts['check:deps:audit']?.includes('check-deps-audit'),
        'check:deps:audit must point at the gate script');
});
