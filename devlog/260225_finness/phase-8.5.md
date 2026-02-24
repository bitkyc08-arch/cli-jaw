# Phase 8.5: 의존성 검증 게이트 설계 (Offline/Online 이중 체크)

> 이 문서는 Phase 8의 P2(의존성/정적분석 안전선) 설계를 다룬다.

---

## 왜 해야 하는가

### 현재 상태

```bash
$ npm audit --json
npm error code ENOTFOUND
npm error errno ENOTFOUND
npm error request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed

$ npm outdated --json
npm error code ENOTFOUND
```

현재 개발 환경에서 DNS/네트워크 제한으로 `npm audit`와 `npm outdated`가 **항상 실패**.
즉 의존성 보안 검증이 0% 상태.

### 알려진 advisory

| 패키지 | GHSA | 영향 범위 | 현재 버전 | 판정 |
|---|---|---|---|---|
| `ws` | GHSA-3h5v-q93c-6h6q (DoS) | `>=8.0.0 <8.17.1` | `8.19.0` | ✅ 안전 |
| `node-fetch` | GHSA-r683-j2x4-v87g (header) | `<2.6.7` or `>=3.0.0 <3.1.1` | `3.3.2` + `2.7.0` | ✅ 안전 |
| `better-sqlite3` | - | 11.x → 12.x 갭 | `11.10.0` | ⚠️ 메이저 추적 |

현재는 안전하지만 **새 advisory가 나왔을 때 감지 시스템이 없음**.

---

## 설계: 이중 게이트

### Gate 1: 오프라인 (항상 실행 가능)

`package-lock.json`에서 resolved 버전을 읽고 금지 범위와 비교.

#### `scripts/check-deps-offline.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const lockPath = path.resolve('package-lock.json');
if (!fs.existsSync(lockPath)) { console.error('[deps] lock not found'); process.exit(2); }

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const pkgs = lock.packages || {};

function ver(p) { return pkgs[p]?.version || null; }
function semver(v) {
  const m = String(v||'').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function lt(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
function gte(a, b) { return !lt(a, b); }
function inRange(v, lo, hi) {
  const sv = semver(v);
  return sv && gte(sv, semver(lo)) && lt(sv, semver(hi));
}

const rules = [
  { pkg: 'node_modules/ws', test: v => inRange(v, '8.0.0', '8.17.1'),
    adv: 'GHSA-3h5v-q93c-6h6q', why: 'DoS' },
  { pkg: 'node_modules/node-fetch', test: v => inRange(v, '3.0.0', '3.1.1') || lt(semver(v), semver('2.6.7')),
    adv: 'GHSA-r683-j2x4-v87g', why: 'header forwarding' },
  { pkg: 'node_modules/grammy/node_modules/node-fetch',
    test: v => lt(semver(v), semver('2.6.7')),
    adv: 'GHSA-r683-j2x4-v87g', why: 'transitive' },
];

let fail = 0;
for (const r of rules) {
  const v = ver(r.pkg);
  if (!v) { console.log(`SKIP ${r.pkg} (not installed)`); continue; }
  if (r.test(v)) { fail++; console.error(`FAIL ${r.pkg}@${v} → ${r.adv} (${r.why})`); }
  else { console.log(`PASS ${r.pkg}@${v}`); }
}

process.exit(fail > 0 ? 1 : 0);
```

### Gate 2: 온라인 (네트워크 가능 환경)

#### `scripts/check-deps-online.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p .artifacts

echo '[online] npm audit'
npm audit --json > .artifacts/npm-audit.json 2>&1 || {
  echo '[online] audit failed'; cat .artifacts/npm-audit.json; exit 1
}

echo '[online] npm outdated'
npm outdated --json > .artifacts/npm-outdated.json 2>&1 || true

if command -v semgrep >/dev/null; then
  echo '[online] semgrep'
  semgrep ci --json --json-output .artifacts/semgrep.json || true
  semgrep ci --sarif --sarif-output .artifacts/semgrep.sarif || true
fi

echo '[online] done — check .artifacts/'
```

### package.json 스크립트 추가

```json
{
  "scripts": {
    "check:deps": "node scripts/check-deps-offline.mjs",
    "check:deps:online": "bash scripts/check-deps-online.sh",
    "pretest": "node scripts/check-deps-offline.mjs"
  }
}
```

`pretest`에 연결하면 `npm test` 실행 전 자동으로 오프라인 체크 수행.

---

## 충돌 분석

| 대상 | 변경 | 충돌 위험 |
|---|---|---|
| `scripts/check-deps-offline.mjs` | **NEW** | 없음 |
| `scripts/check-deps-online.sh` | **NEW** | 없음 |
| `package.json` | scripts 추가 | 낮음 — 기존 스크립트와 키 충돌 없음 |
| Phase 8.1~8.4 | 완전 독립 | 없음 |

**병렬 작업 가능**: 8.5는 코드 변경이 아니라 스크립트 추가이므로 8.1~8.4와 동시 진행 가능.

---

## 테스트 계획

### 오프라인 스크립트 자체 검증

```bash
# 정상 케이스: 현재 lock으로 실행
$ node scripts/check-deps-offline.mjs
PASS node_modules/ws@8.19.0
PASS node_modules/node-fetch@3.3.2
SKIP node_modules/grammy/node_modules/node-fetch (not installed)
# exit 0
```

```bash
# 이상 케이스: lock을 임시 조작
$ cp package-lock.json /tmp/lock-backup.json
# lock에서 ws 버전을 8.16.0으로 수동 변경
$ node scripts/check-deps-offline.mjs
FAIL node_modules/ws@8.16.0 → GHSA-3h5v-q93c-6h6q (DoS)
# exit 1
$ cp /tmp/lock-backup.json package-lock.json
```

### 단위 테스트: `tests/unit/deps-check.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// semver helper 로직 단위 테스트 (스크립트에서 추출)
function semver(v) {
  const m = String(v||'').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function lt(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

test('DV-001: semver parse', () => {
  assert.deepEqual(semver('8.19.0'), [8, 19, 0]);
  assert.equal(semver('invalid'), null);
});

test('DV-002: lt comparison', () => {
  assert.ok(lt([8, 16, 0], [8, 17, 1]));
  assert.ok(!lt([8, 19, 0], [8, 17, 1]));
});

test('DV-003: ws safe version', () => {
  const v = [8, 19, 0];
  const inRange = !lt(v, semver('8.0.0')) && lt(v, semver('8.17.1'));
  assert.ok(!inRange, 'ws 8.19.0 should NOT be in vulnerable range');
});

test('DV-004: ws vulnerable version', () => {
  const v = [8, 16, 0];
  const inRange = !lt(v, semver('8.0.0')) && lt(v, semver('8.17.1'));
  assert.ok(inRange, 'ws 8.16.0 should be in vulnerable range');
});
```

### 실행

```bash
node --test tests/unit/deps-check.test.js
node scripts/check-deps-offline.mjs
```

---

## 완료 기준

- [ ] 오프라인 스크립트 exit 0 (현재 환경)
- [ ] 취약 버전 강제 시 exit 1 확인
- [ ] `package.json`에 `check:deps` 스크립트 추가
- [ ] 단위 테스트 4/4 통과
- [ ] `.artifacts/` 디렉토리 `.gitignore`에 추가
