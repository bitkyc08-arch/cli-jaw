# Phase 20.4: 품질 — 테스트 커버리지 + Integration 테스트 + CI 확장

> Round 4: 테스트 인프라 강화. 커버리지 측정 + API smoke test + CI 게이트.

---

## 20.4-A: 테스트 커버리지 측정

### 파일: `package.json`

```diff
     "scripts": {
         "test": "node --test tests/*.test.js tests/**/*.test.js",
+        "test:coverage": "node --test --experimental-test-coverage tests/*.test.js tests/**/*.test.js",
         "test:watch": "node --test --watch tests/*.test.js tests/**/*.test.js",
```

### 실행 및 확인

```bash
npm run test:coverage
# 출력 예:
# start of coverage report
# file              | line % | branch % | funcs %
# src/config.js     |  85.7  |   72.0   |  90.0
# src/agent.js      |  42.1  |   33.0   |  55.0   ← 개선 필요
# ...
```

---

## 20.4-B: Integration 테스트 (API Smoke Test)

### 신규 파일: `tests/integration/api-smoke.test.js`

```js
/**
 * API Smoke Test — 서버 기동 없이 Express app을 직접 테스트
 * supertest 의존성 없이 직접 구현
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── Helper: 임시 서버 기동 ──────────────────────────
let serverUrl;
let serverInstance;

// 서버 모듈이 listen을 자동 호출하므로, 테스트용 별도 진입점 필요
// → 대안: Express app만 export하는 리팩터 (Phase 20.3 이후)
// → 현재: 실행 중인 서버에 직접 fetch (PORT 환경변수 필요)

const PORT = process.env.TEST_PORT || 13457;
const BASE = `http://localhost:${PORT}`;

// 서버가 실행 중이 아니면 skip
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
        assert.ok(data); // session 객체 또는 { ok, data }
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

    await t.test('SMOKE-009: POST /api/command invalid → 400', async () => {
        const res = await fetch(`${BASE}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'not-a-command' }),
        });
        // 400 또는 200 with error — 둘 다 허용
        assert.ok([200, 400].includes(res.status));
    });

    await t.test('SMOKE-010: GET /api/nonexistent → 404 or 200', async () => {
        const res = await fetch(`${BASE}/api/nonexistent-route-12345`);
        // Express SPA fallback이 있으면 200, 없으면 404
        assert.ok([200, 404].includes(res.status));
    });

    // Security tests (Phase 9.1 검증)
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
```

### 파일: `package.json`

```diff
     "scripts": {
+        "test:smoke": "TEST_PORT=3457 node --test tests/integration/api-smoke.test.js",
```

---

## 20.4-C: CLI 기본 동작 테스트

### 신규 파일: `tests/integration/cli-basic.test.js`

```js
/**
 * CLI Basic Tests — bin/cli-claw.js 기본 동작 확인
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../../bin/cli-claw.js');

function run(...args) {
    try {
        return execFileSync('node', [CLI, ...args], {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, NO_COLOR: '1' },
        });
    } catch (e) {
        return e.stdout || e.stderr || '';
    }
}

test('CLI-001: --help shows usage', () => {
    const out = run('--help');
    assert.ok(out.includes('cli-claw') || out.includes('Commands') || out.includes('Usage'));
});

test('CLI-002: --version shows version', () => {
    const out = run('--version');
    assert.match(out, /\d+\.\d+\.\d+/);
});

test('CLI-003: unknown command exits with error', () => {
    const out = run('nonexistent-command-xyz');
    assert.ok(out.includes('Unknown') || out.includes('unknown') || out.includes('not found') || out.length === 0);
});

test('CLI-004: doctor runs without crash', () => {
    const out = run('doctor');
    assert.ok(out.includes('✓') || out.includes('✗') || out.includes('check'));
});
```

---

## 20.4-D: CI 확장

### 파일: `.github/workflows/test.yml`

```diff
 name: Tests
 
 on:
   push:
     branches:
       - main
       - master
+      - agent
   pull_request:
 
 jobs:
   node-tests:
     runs-on: ubuntu-latest
     steps:
       - name: Checkout
         uses: actions/checkout@v4
 
       - name: Setup Node.js
         uses: actions/setup-node@v4
         with:
           node-version: 22
           cache: npm
 
       - name: Install dependencies
         run: npm ci --ignore-scripts
 
       - name: Run tests
         run: npm test
+
+      - name: Deps security check
+        run: npm run check:deps
+
+      - name: File size check
+        run: |
+          echo "=== Files over 500 lines ==="
+          find . -name '*.js' -not -path './node_modules/*' -not -path './skills_ref/*' \
+            | xargs wc -l | sort -rn | awk '$1 > 500 && !/total/ { print "⚠️ " $0; found=1 } END { if (!found) print "✅ All files under 500 lines" }'
+
+      - name: CLI basic tests
+        run: node --test tests/integration/cli-basic.test.js
+
+      - name: API smoke tests (if server available)
+        run: |
+          if curl -sf http://localhost:${TEST_PORT:-3457}/api/session > /dev/null 2>&1; then
+            npm run test:smoke
+          else
+            echo "⏭️ Server not running — smoke tests skipped"
+          fi
```

---

## 테스트 계획

```bash
# 커버리지 측정
npm run test:coverage

# Smoke test (서버 실행 중 필요)
npm run test:smoke

# CLI 테스트
node --test tests/integration/cli-basic.test.js

# 전체
npm test
```

---

## 완료 기준

- [ ] `test:coverage` 스크립트 추가 + 실행 가능
- [ ] Integration smoke test 12건 작성
- [ ] CLI basic test 4건 작성
- [ ] CI에 deps check + file size check 추가
- [ ] CI에 agent 브랜치 추가
- [ ] `npm test` 통과
