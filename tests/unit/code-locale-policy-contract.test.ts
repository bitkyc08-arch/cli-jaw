import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Slice 218: Code mode runtime-label locale policy.
// Policy (devlog 208/218): runtime Code labels stay English; the compact header
// shows workspace state by component shape (picker button / plain chip), not by
// explanatory prose. Korean lives only in user-facing reports and devlog.

const root = join(import.meta.dirname, '..', '..');
const codeDir = join(root, 'public/manager/src/code');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

const codeFiles = walk(codeDir).filter(f => /\.(ts|tsx|css)$/.test(f));

test('Code mode runtime labels contain no Hangul (English-only policy)', () => {
    const hangul = /[가-힣]/;
    const offenders = codeFiles.filter(f => hangul.test(readFileSync(f, 'utf8')))
        .map(f => f.slice(root.length + 1));
    assert.equal(offenders.length, 0, `Code mode runtime files must not contain Hangul: ${offenders.join(', ')}`);
});

test('Code workspace header shows state by shape, not explanatory lock prose (slice 218)', () => {
    const header = readFileSync(join(codeDir, 'CodeWorkspaceHeader.tsx'), 'utf8');
    // Removed in slice 210b; the chip/button shape now conveys frozen vs editable.
    assert.equal(header.includes('fixed for this session'), false, 'header must not render explanatory lock copy');
    assert.equal(header.includes('Apply Code working directory'), false, 'header must not render the old apply hint');
    assert.ok(header.includes('code-workspace-picker') && header.includes('code-workspace-chip'), 'workspace state is shown by picker button / plain chip shape');
});
