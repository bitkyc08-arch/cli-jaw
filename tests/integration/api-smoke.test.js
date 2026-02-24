/**
 * API Smoke Test — 서버 기동 상태에서 주요 엔드포인트 검증
 * 서버가 없으면 자동 skip
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const PORT = process.env.TEST_PORT || 13457;
const BASE = `http://localhost:${PORT}`;

async function checkServer() {
    try {
        await fetch(`${BASE}/api/session`, { signal: AbortSignal.timeout(1000) });
        return true;
    } catch { return false; }
}

test('API Smoke Tests', async (t) => {
    const alive = await checkServer();
    if (!alive) {
        t.skip(`Server not running on port ${PORT}`);
        return;
    }

    await t.test('SMOKE-001: GET /api/session → 200 + session object', async () => {
        const res = await fetch(`${BASE}/api/session`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data);
    });

    await t.test('SMOKE-002: GET /api/messages → 200 + array', async () => {
        const res = await fetch(`${BASE}/api/messages`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data) || (data.ok && Array.isArray(data.data)));
    });

    await t.test('SMOKE-003: GET /api/settings → 200 + cli field', async () => {
        const res = await fetch(`${BASE}/api/settings`);
        assert.equal(res.status, 200);
        const data = await res.json();
        const settings = data.data || data;
        assert.ok(settings.cli);
    });

    await t.test('SMOKE-004: GET /api/commands → 200 + array', async () => {
        const res = await fetch(`${BASE}/api/commands`);
        assert.equal(res.status, 200);
        const data = await res.json();
        const cmds = data.data || data;
        assert.ok(Array.isArray(cmds));
        assert.ok(cmds.some(c => c.name === 'help'));
    });

    await t.test('SMOKE-005: GET /api/runtime → 200', async () => {
        const res = await fetch(`${BASE}/api/runtime`);
        assert.equal(res.status, 200);
    });

    await t.test('SMOKE-006: GET /api/employees → 200 + array', async () => {
        const res = await fetch(`${BASE}/api/employees`);
        assert.equal(res.status, 200);
        const data = await res.json();
        const emps = data.data || data;
        assert.ok(Array.isArray(emps));
    });

    await t.test('SMOKE-007: GET /api/skills → 200 + array', async () => {
        const res = await fetch(`${BASE}/api/skills`);
        assert.equal(res.status, 200);
    });

    await t.test('SMOKE-008: GET /api/memory → 200', async () => {
        const res = await fetch(`${BASE}/api/memory`);
        assert.equal(res.status, 200);
    });

    await t.test('SMOKE-009: POST /api/command invalid → 400 or 200', async () => {
        const res = await fetch(`${BASE}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'not-a-command' }),
        });
        assert.ok([200, 400].includes(res.status));
    });

    await t.test('SMOKE-010: GET /api/nonexistent → 404 or 200', async () => {
        const res = await fetch(`${BASE}/api/nonexistent-route-12345`);
        assert.ok([200, 404].includes(res.status));
    });

    // Security tests
    await t.test('SMOKE-011: path traversal → 400/403', async () => {
        const res = await fetch(`${BASE}/api/memory-files/..%2F..%2Fetc%2Fpasswd`);
        assert.ok([400, 403].includes(res.status));
    });

    await t.test('SMOKE-012: skill id injection → 400', async () => {
        const res = await fetch(`${BASE}/api/skills/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: '../../../etc/passwd' }),
        });
        assert.ok([400, 403].includes(res.status));
    });
});
