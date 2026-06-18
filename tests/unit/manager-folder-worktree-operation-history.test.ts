import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addFolderGitOperationHistoryItem,
    createFolderGitOperationHistoryItem,
    finishFolderGitOperationHistoryItem,
    type FolderGitOperationHistoryItem,
} from '../../public/manager/src/folder-panel/folder-git-operation-history.js';
import type { GitWorktreeOperationPreview } from '../../public/manager/src/folder-panel/folder-worktree-types.js';

const preview: GitWorktreeOperationPreview = {
    command: ['git', 'worktree', 'prune'],
    label: 'Prune stale worktrees',
    destructive: true,
    requiresConfirmation: true,
};

test('worktree operation history stores running and success results', () => {
    const item = createFolderGitOperationHistoryItem({ type: 'worktree-prune' }, preview);
    assert.equal(item.status, 'running');
    assert.deepEqual(item.commandPreview, preview.command);

    const history = finishFolderGitOperationHistoryItem([item], item.id, { ok: true, stdout: 'pruned\n' });
    assert.equal(history[0]?.status, 'succeeded');
    assert.equal(history[0]?.stdout, 'pruned\n');
    assert.equal(history[0]?.error, null);
    assert.ok(history[0]?.finishedAt);
});

test('worktree operation history classifies blocked guardrail errors', () => {
    const item = createFolderGitOperationHistoryItem({ type: 'worktree-prune' }, preview);
    const history = finishFolderGitOperationHistoryItem([item], item.id, { ok: false, error: 'worktree has uncommitted changes' });

    assert.equal(history[0]?.status, 'blocked');
    assert.equal(history[0]?.error, 'worktree has uncommitted changes');
});

test('worktree operation history remains bounded', () => {
    let history: FolderGitOperationHistoryItem[] = [];
    for (let idx = 0; idx < 12; idx += 1) {
        history = addFolderGitOperationHistoryItem(
            history,
            createFolderGitOperationHistoryItem({ type: 'worktree-prune' }, { ...preview, label: `op ${idx}` }),
        );
    }

    assert.equal(history.length, 8);
    assert.equal(history[0]?.operationLabel, 'op 11');
    assert.equal(history[7]?.operationLabel, 'op 4');
});
