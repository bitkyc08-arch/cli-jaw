import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    createNativeDiffTransport,
    createDashboardGitDiffTransport,
} from '../../public/dashboard2/src/features/panels/diff-transport.ts';
import type { DiffBridgeApi } from '../../public/dashboard2/src/providers/desktop-bridge-contract.ts';

const panel = readFileSync('public/dashboard2/src/features/panels/DiffPanel.tsx', 'utf8');
const sidePane = readFileSync('public/dashboard2/src/shell/SidePane.tsx', 'utf8');
const scope = readFileSync('public/dashboard2/src/state/scope.tsx', 'utf8');

test('native transport resolves and freezes root before summary/file/operation calls', async () => {
    const calls: string[] = [];
    const native = {
        getRepoRoot: async (cwd: string) => { calls.push(`root:${cwd}`); return { ok: true, root: '/repo' }; },
        getRepoCandidates: async () => ({ ok: true, candidates: [] }),
        getDiffSummary: async (root: string) => { calls.push(`summary:${root}`); return { ok: true, files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }] }; },
        getFileDiff: async (root: string, path: string) => { calls.push(`file:${root}:${path}`); return { ok: true, diff: '+x' }; },
        runScmOperation: async (root: string) => { calls.push(`operation:${root}`); return { ok: true }; },
    } as DiffBridgeApi;
    const transport = createNativeDiffTransport(native);
    const root = await transport.resolveRepoRoot('/work');
    await transport.getSummary(root, { mode: 'unstaged' });
    await transport.getFileDiff(root, 'a.ts', { mode: 'unstaged' });
    await transport.runScmOperation(root, { kind: 'stage', paths: ['a.ts'] });
    assert.deepEqual(calls, ['root:/work', 'summary:/repo', 'file:/repo:a.ts', 'operation:/repo']);
});

test('web transport uses only manager git POST routes with one selected port/root', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ path, body });
        const payload = path.endsWith('repo-candidates') ? { ok: true, candidates: [{ root: '/repo' }] }
            : path.endsWith('diff-summary') ? { ok: true, files: [] }
            : path.endsWith('file-diff') ? { ok: true, diff: '' } : { ok: true };
        return { ok: true, status: 200, json: async () => payload } as Response;
    }) as typeof fetch;
    try {
        const transport = createDashboardGitDiffTransport(3457);
        const root = await transport.resolveRepoRoot('/ignored');
        await transport.getSummary(root, { mode: 'unstaged' });
        await transport.getFileDiff(root, 'a.ts', { mode: 'unstaged' });
        await transport.runScmOperation(root, { kind: 'stage', paths: ['a.ts'] });
        assert.deepEqual(calls.map((call) => call.path), [
            '/api/dashboard/git/repo-candidates', '/api/dashboard/git/diff-summary',
            '/api/dashboard/git/file-diff', '/api/dashboard/git/scm-operation',
        ]);
        for (const call of calls) assert.equal(call.body['selectedInstancePort'], 3457);
        for (const call of calls.slice(1)) assert.equal(call.body['repoRoot'], '/repo');
    } finally { globalThis.fetch = originalFetch; }
});

test('DiffPanel mounts through 089.04 openPanel contract and removes worker git URLs', () => {
    assert.match(scope, /\| 'diff'/);
    assert.match(sidePane, /id: 'diff'/);
    assert.match(sidePane, /LazyDiffPanel active=\{active\} payload=\{payload\}/);
    assert.match(panel, /requestGeneration\.current !== generation/);
    assert.match(panel, /api\.fetchInstances\(\)/);
    assert.match(panel, /transport\.resolveRepoRoot\(workingDir\)/);
    assert.match(panel, /paths: \[filePath\]/);
    assert.doesNotMatch(panel, /\/i\/\$\{port\}\/api\/git/);
    assert.doesNotMatch(sidePane, /UnifiedDiffSegment|widget.*promot/i);
});
