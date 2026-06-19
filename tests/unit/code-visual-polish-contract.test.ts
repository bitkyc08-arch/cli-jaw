import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

// Slice 219: final dense-workbench polish. Header path de-duplication landed in 210b
// and the /model popup was decomposed in 214; this slice flattens the repeated
// bordered-card model rows so emphasis comes from hover + selection, not every row.

test('model browser rows are flattened (no heavy border on every row; emphasis on hover/selection)', () => {
    const css = read('public/manager/src/code/code-command-popup-model.css');
    const base = css.slice(css.indexOf('.code-model-provider,'), css.indexOf('.code-model-provider.is-selected'));
    assert.ok(base.includes('border: 1px solid transparent'), 'base rows must not carry a heavy border');
    assert.ok(base.includes('background: transparent'), 'base rows must not look like filled cards');
    assert.ok(css.includes('.code-model-row:hover'), 'rows must show a hover affordance');
    // Selection / active emphasis is retained.
    assert.ok(css.includes('.code-model-row.is-draft') && css.includes('var(--accent-default)'), 'selected/draft row keeps accent emphasis');
    assert.ok(css.includes('.code-model-row.is-active'), 'active row keeps its emphasis');
});

test('header no longer repeats the workspace path (slice 219 scannability)', () => {
    const header = read('public/manager/src/code/CodeWorkspaceHeader.tsx');
    // One workspace label (picker/chip) + git pills; no repo/path duplication.
    assert.equal(header.includes('code-workspace-repo'), false, 'no repo path pill');
    assert.equal(header.includes('code-workspace-path'), false, 'no cwd-relative path pill');
    assert.ok(header.includes('code-workspace-picker') || header.includes('code-workspace-chip'), 'single workspace label remains');
    assert.ok(header.includes('worktree {worktreeCount}'), 'compact worktree pill (count only, no repeated path)');
});
