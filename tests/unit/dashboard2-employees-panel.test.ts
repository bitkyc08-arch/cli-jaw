import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEmployeeSurface } from '../../public/dashboard2/src/features/employees/employees-api.ts';
import { readSource } from './source-normalize.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readSource(join(projectRoot, path), 'utf8');

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

test('employee adapter uses only selected-worker read endpoints and joins strictly by employee id', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/employees')) {
            return response({ ok: true, data: [
                { id: 'emp-a', name: 'Alpha', cli: 'codex', model: 'gpt', role: 'Audit' },
                { id: 'emp-b', name: 'Beta', cli: 'claude', model: null, role: null },
                { id: '', name: 'Malformed' },
            ] });
        }
        if (url.endsWith('/orchestrate/workers')) {
            return response([{ agentId: 'emp-a', state: 'running', task: 'Inspect the implementation' }]);
        }
        return response({ ok: true, workers: [
            {
                agentId: 'emp-a', employeeName: 'Wrong name must not be a join key',
                current: {
                    state: 'running', taskPreview: 'Review transport', progressUpdatedAt: 100,
                    attention: { kind: 'stalled', message: 'No recent output' },
                },
                previous: { state: 'done', taskPreview: 'Old task must not appear as current', progressUpdatedAt: 50 },
            },
            { agentId: 'emp-b', employeeName: 'Beta', current: null, previous: { state: 'done', taskPreview: 'Completed task' } },
            { agentId: 'not-in-roster', employeeName: 'Alpha', current: { state: 'running', taskPreview: 'Wrong join' } },
        ] });
    };

    const result = await loadEmployeeSurface(3457, { fetchImpl, now: () => 999 });
    assert.deepEqual(requests, [
        { url: '/i/3457/api/employees', method: 'GET' },
        { url: '/i/3457/api/orchestrate/workers', method: 'GET' },
        { url: '/i/3457/api/orchestrate/worker-progress', method: 'GET' },
    ]);
    assert.equal(result.loadedAt, 999);
    assert.equal(result.rows.length, 2, 'malformed and progress-only rows are excluded');
    assert.equal(result.rows[0]?.id, 'emp-a', 'running employee sorts first');
    assert.equal(result.rows[0]?.taskPreview, 'Review transport');
    assert.equal(result.rows[0]?.attention?.kind, 'stalled');
    assert.equal(result.rows[1]?.taskPreview, null, 'same-name progress with a different id must not join');
});

test('progress failures retain roster as a partial read-only result', async () => {
    const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/employees')) return response([{ id: 'emp-a', name: 'Alpha', cli: 'codex' }]);
        return response({ error: 'unavailable' }, 503);
    };
    const result = await loadEmployeeSurface(3458, { fetchImpl });
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.warnings, ['Active worker status is unavailable.', 'Worker progress is unavailable.']);
    assert.equal(result.rows[0]?.state, 'idle');
});

test('Employees panel is read-only and owns bounded active/visibility polling with a stale guard', () => {
    const panel = read('public/dashboard2/src/features/employees/EmployeesPanel.tsx');
    const api = read('public/dashboard2/src/features/employees/employees-api.ts');
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');

    assert.match(panel, /EMPLOYEES_POLL_INTERVAL_MS\s*=\s*5_000/);
    assert.ok(panel.includes('if (!active) return;'));
    assert.ok(panel.includes('if (document.hidden) return;'));
    assert.ok(panel.includes("document.addEventListener('visibilitychange'"));
    assert.ok(panel.includes('requestGeneration.current !== generation'));
    assert.ok(panel.includes('controller?.abort()'));
    assert.doesNotMatch(`${panel}\n${api}`, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    assert.doesNotMatch(panel, /Create|Edit|Delete|Dispatch|Cancel|Retry/);
    assert.match(sidePane, /id:\s*'employees'.*keepAlive:\s*false.*needsSession:\s*true/);
    assert.match(sidePane, /<LazyEmployeesPanel active=\{active\} port=\{port!\}/);
});
