---
created: 2026-02-25
status: planning
tags: [cli-claw, finness, phase-8, backend, dependency, security, testing]
---
# Phase 8 (finness): 백엔드 구조 개선 + 의존성 검증 강화 (프런트 제외)

> 목적: `dev / dev-backend / dev-data / dev-testing` 지침을 코드/의존성/테스트 레벨에서 재검증하고, Phase 9 실행을 위한 근거 중심의 상세 계획을 만든다.
> 범위: `server.js`, `src/*.js`, `lib/*.js`, `tests/**/*.test.js`, `package.json`, `package-lock.json`
> 제외: 프런트엔드 UI/스타일/번들링 개선 (`public/*`, CSS, 화면 컴포넌트)

---

## 0) 요약 (핵심 결론)

1. 구조 리스크는 여전히 큼
- `500줄 초과 파일`이 5개이며, 특히 `server.js`에 API 라우트가 과집중됨.
- `catch {}`가 백엔드 범위에서 63건으로, 의도된 fallback과 위험한 무시가 혼재됨.

2. 의존성 자체는 "치명적 즉시 취약" 신호는 낮음
- `ws`/`node-fetch`는 공개 GHSA 기준 취약 구간을 벗어나 있음.
- 다만 `better-sqlite3`는 메이저 업그레이드 갭(11.x → 12.x)이 있어 Node 22 호환 회귀 테스트가 필요함.

3. 검증 파이프라인이 빈약함
- `npm audit`, `npm outdated`는 현재 환경에서 DNS 제한으로 실패(ENOTFOUND).
- 따라서 오프라인 체크(락파일 정책 검사) + 온라인 체크(네트워크 가능 환경)의 이중 게이트가 필요함.

4. Phase 9에서는 “보안 입력 검증 + API 계약 통일 + 테스트 확장 + 의존성 게이트”를 한 번에 닫아야 함
- 특히 `memory-files`, `skills`, `upload` 계열 라우트는 경로/식별자 검증을 강제해야 함.

---

## 1) 검증 기준 (skills_ref/dev* 근거)

아래는 실제 `skills_ref` 원문을 기준으로 Phase 8에서 강제할 항목이다.

### 1.1 `dev`에서 직접 가져온 필수 규칙

- 단일 파일 500줄 초과 금지
- 모듈 책임 분리
- 하드코딩 설정 최소화 (`config.js`, `settings.json` 우선)
- 조용한 실패 금지 (`catch` 시 최소 로깅)

### 1.2 `dev-backend`에서 가져온 필수 규칙

- API 응답 형식 일관화 (`{ ok, data }`, `{ ok, error }`)
- async 핸들러 예외 처리 일관성
- 입력 검증(타입/길이/범위)

### 1.3 `dev-data`에서 가져온 필수 규칙

- 외부 입력 방어적 파싱
- 스키마 우선 검증
- 파이프라인 단계 분리(입력 → 정제 → 저장)

### 1.4 `dev-testing`에서 가져온 필수 규칙

- 재현 가능한 자동 검증 루프
- 테스트 러너 기반의 회귀 방지
- 정적분석/도구 기반 리그레션 게이트 병행

---

## 2) 현재 코드베이스 실측 스냅샷 (2026-02-25 기준)

아래 수치는 로컬에서 명령으로 재집계했다.

### 2.1 파일 크기

```bash
wc -l server.js src/commands.js src/agent.js src/orchestrator.js src/prompt.js src/config.js src/telegram.js
```

결과:

| 파일 | 줄 수 | 상태 |
|---|---:|---|
| `server.js` | 947 | 기준 초과 |
| `src/commands.js` | 658 | 기준 초과 |
| `src/agent.js` | 619 | 기준 초과 |
| `src/orchestrator.js` | 584 | 기준 초과 |
| `src/prompt.js` | 497 | 적정 (경계 이하) |
| `src/config.js` | 177 | 적정 |
| `src/telegram.js` | 493 | 경계 |

### 2.2 API 라우트 수

```bash
rg -n "app\.(get|post|put|patch|delete)\('/api" server.js | wc -l
```

결과: `62` (작성 시점)

해석:
- 단일 파일에 엔드포인트가 과밀되어 있고, 요청 검증/응답 포맷/예외 처리 정책이 기능별로 일관되지 않음.

### 2.3 조용한 catch 분포

```bash
rg -n "catch \{" server.js src lib tests -g'*.js' | wc -l
rg -n "catch \{" server.js src lib tests -g'*.js' | awk -F: '{print $1}' | sort | uniq -c | sort -nr
```

결과 총합: `63`

상위 분포:

| 파일 | 건수 | 코멘트 |
|---|---:|---|
| `src/prompt.js` | 12 | 초기화 fallback 성격 다수 |
| `lib/mcp-sync.js` | 12 | 외부 환경 편차 대응 다수 |
| `server.js` | 8 | 일부 라우트에서 무시형 처리 |
| `src/orchestrator.js` | 7 | 파싱/보조 흐름 무시형 존재 |
| `src/telegram.js` | 5 | lifecycle/파싱 실패 무시형 존재 |
| `src/agent.js` | 4 | kill 실패/파싱 실패 무시 |
| `src/config.js` | 3 | 설정 fallback |

해석:
- “무조건 로깅 추가”가 정답은 아님.
- 하지만 사용자 입력/네트워크/프로세스 제어 영역의 `catch {}`는 최소 `warn` 수준으로 관찰 가능하게 바꿔야 함.

### 2.4 테스트 파일 개수

```bash
find tests -name '*.test.js' | wc -l
find tests -name '*.test.js' | sort
```

결과: `9`

현재 존재:
- `tests/events.test.js`
- `tests/events-acp.test.js`
- `tests/telegram-forwarding.test.js`
- `tests/acp-client.test.js`
- `tests/unit/bus.test.js`
- `tests/unit/cli-registry.test.js`
- `tests/unit/commands-parse.test.js`
- `tests/unit/frontend-constants.test.js`
- `tests/unit/worklog.test.js`

해석:
- 핵심 위험 모듈(`agent`, `orchestrator`, `server` 라우트 검증)에 대한 단위/통합 테스트가 부족함.

### 2.5 설치 의존성 실버전

```bash
npm ls --depth=0
npm ls node-fetch
```

실버전:

| 패키지 | declared | resolved (lock/install) |
|---|---|---|
| `express` | `^4.21.0` | `4.22.1` |
| `ws` | `^8.18.0` | `8.19.0` |
| `node-fetch` | `^3.3.2` | `3.3.2` |
| `node-fetch` (transitive via grammy) | - | `2.7.0` |
| `better-sqlite3` | `^11.7.0` | `11.10.0` |
| `playwright-core` | `^1.58.2` | `1.58.2` |
| `grammy` | `^1.40.0` | `1.40.0` |

---

## 3) Context7 + Websearch 교차 검증

이 섹션은 문서 근거를 “로컬 추측”이 아니라 공식 문서/공식 advisory로 고정한다.

### 3.1 Express 보안/에러 처리

근거:
- Express 보안 베스트 프랙티스: 최신 버전 사용, 취약성 점검 권장
- Express API `res.sendFile` 주의: 사용자 입력 경로를 직접 넣을 때 `root` 옵션 또는 경로 정제 필요
- Context7 Express: async handler wrapper + global error middleware + body parser limit 예시

Phase 8 반영:
- 라우트 공통 `asyncHandler` 적용
- 공통 에러 응답 미들웨어 추가
- `express.json / urlencoded / raw` limit 정책 문서화
- 파일/경로 입력은 `resolve + base prefix check`로 고정

### 3.2 취약점 advisory (패키지별)

#### ws
- GHSA: `GHSA-3h5v-q93c-6h6q` (DoS)
- 영향 범위: `>=8.0.0 <8.17.1`
- 현재 resolved: `8.19.0`
- 판정: 해당 advisory 기준 안전 구간

#### node-fetch
- GHSA: `GHSA-r683-j2x4-v87g` (forwarded secure headers)
- 영향 범위: `<2.6.7`, `>=3.0.0 <3.1.1`
- 현재 versions: `3.3.2` + transitive `2.7.0`
- 판정: 두 버전 모두 advisory 범위 밖

### 3.3 버전 추적 근거

릴리스 페이지 확인:
- `express` 최신 릴리스 흐름에 `4.22.1` 확인
- `ws` 최신 릴리스 `8.19.0` 확인
- `better-sqlite3` 최신 릴리스 계열은 12.x로 진행
- `playwright` 릴리스 `1.58.2` 확인

해석:
- `express/ws/playwright-core`는 현재 설치 버전이 최신 릴리스와 차이가 적거나 동일.
- `better-sqlite3`는 메이저 업그레이드 갭이 있어 성능/호환성/보안 공지 추적이 필요.

### 3.4 npm/semgrep/node-test 공식 CLI 근거

- `npm audit`: 취약점 DB 기반 보안 점검
- `npm outdated`: wanted/latest 비교
- Node test runner: `--test-coverage-lines/functions/branches` 최소 임계치 옵션 제공
- Semgrep: `--json`, `--sarif`, `--baseline-commit` 기반 증분 스캔 가능

---

## 4) 의존성 검증의 현실 제약과 해결 방식

### 4.1 현재 환경 제약

실행 결과:
- `npm audit --json` 실패: `ENOTFOUND registry.npmjs.org`
- `npm outdated --json` 실패: 동일 DNS/네트워크 문제
- `semgrep` 미설치 (`command not found`)

결론:
- 온라인 체크만 전제하면 로컬에서 지속적으로 검증이 깨진다.
- 오프라인 체크를 1차 게이트로 두고, 온라인 체크는 2차 게이트로 분리해야 한다.

### 4.2 이중 게이트 전략

1차 (오프라인, 항상 실행 가능)
- `package-lock.json` 기반 버전 정책 검사
- 금지 버전 범위 차단
- 라우트/코드 레벨 정규식 기반 빠른 스캔

2차 (온라인, 네트워크 가능 환경)
- `npm audit --json`
- `npm outdated --json`
- `semgrep ci --json --sarif`

---

## 5) 의존성 체크 코드 스니펫 (즉시 적용 가능)

아래 스니펫은 "문서용 예시"가 아니라 실제 실행 가능한 형태로 작성했다.

### 5.1 오프라인 락파일 보안 게이트 (`scripts/check-deps-offline.mjs`)

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const lockPath = path.resolve('package-lock.json');
if (!fs.existsSync(lockPath)) {
  console.error('[deps:offline] package-lock.json not found');
  process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages || {};

function getVersion(pkgPath) {
  return packages[pkgPath]?.version || null;
}

function parse(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function inRange(v, minInc, maxEx) {
  const pv = parse(v);
  const pMin = parse(minInc);
  const pMax = parse(maxEx);
  if (!pv || !pMin || !pMax) return false;
  return cmp(pv, pMin) >= 0 && cmp(pv, pMax) < 0;
}

const checks = [
  {
    name: 'ws',
    paths: ['node_modules/ws'],
    rule: (v) => inRange(v, '8.0.0', '8.17.1'),
    advisory: 'GHSA-3h5v-q93c-6h6q',
    why: 'DoS range >=8.0.0 <8.17.1'
  },
  {
    name: 'node-fetch (direct)',
    paths: ['node_modules/node-fetch'],
    rule: (v) => inRange(v, '3.0.0', '3.1.1') || cmp(parse(v), parse('2.6.7')) < 0,
    advisory: 'GHSA-r683-j2x4-v87g',
    why: 'Header forwarding issue <2.6.7 or >=3.0.0 <3.1.1'
  },
  {
    name: 'node-fetch (grammy transitive)',
    paths: ['node_modules/grammy/node_modules/node-fetch'],
    rule: (v) => inRange(v, '3.0.0', '3.1.1') || cmp(parse(v), parse('2.6.7')) < 0,
    advisory: 'GHSA-r683-j2x4-v87g',
    why: 'Transitive check'
  }
];

let failed = 0;
for (const c of checks) {
  for (const p of c.paths) {
    const v = getVersion(p);
    if (!v) {
      console.log(`[deps:offline] SKIP ${c.name} (${p}) not installed`);
      continue;
    }
    if (c.rule(v)) {
      failed++;
      console.error(`[deps:offline] FAIL ${c.name}@${v} (${p}) -> ${c.advisory} (${c.why})`);
    } else {
      console.log(`[deps:offline] PASS ${c.name}@${v} (${p})`);
    }
  }
}

if (failed > 0) {
  console.error(`[deps:offline] blocked: ${failed} vulnerable package(s)`);
  process.exit(1);
}

console.log('[deps:offline] all checks passed');
```

실행:

```bash
node scripts/check-deps-offline.mjs
```

### 5.2 온라인 의존성 점검 래퍼 (`scripts/check-deps-online.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

mkdir -p .artifacts

echo '[deps:online] npm audit'
if npm audit --json > .artifacts/npm-audit.json; then
  echo '[deps:online] audit ok'
else
  echo '[deps:online] audit failed (network or vulnerability)'
  cat .artifacts/npm-audit.json || true
  exit 1
fi

echo '[deps:online] npm outdated'
if npm outdated --json > .artifacts/npm-outdated.json; then
  echo '[deps:online] outdated report written'
else
  echo '[deps:online] outdated failed'
  cat .artifacts/npm-outdated.json || true
  exit 1
fi

if command -v semgrep >/dev/null 2>&1; then
  echo '[deps:online] semgrep baseline scan'
  semgrep ci --json --json-output .artifacts/semgrep.json
  semgrep ci --sarif --sarif-output .artifacts/semgrep.sarif
else
  echo '[deps:online] semgrep not installed, skip'
fi

cat <<MSG
[deps:online] done
- .artifacts/npm-audit.json
- .artifacts/npm-outdated.json
- .artifacts/semgrep.json (if semgrep installed)
- .artifacts/semgrep.sarif (if semgrep installed)
MSG
```

실행:

```bash
bash scripts/check-deps-online.sh
```

### 5.3 테스트 커버리지 게이트 (Node test runner)

```bash
node --test \
  --experimental-test-coverage \
  --test-coverage-lines=80 \
  --test-coverage-functions=80 \
  --test-coverage-branches=70 \
  tests/*.test.js tests/**/*.test.js
```

권장:
- 초기에는 `lines 70 / functions 70 / branches 60`으로 시작 후 점진 상향.

### 5.4 응답/입력 검증 공통 패턴 (Express + Zod)

```js
import { z } from 'zod';

const skillsIdSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)
});

export function parseSkillsId(body) {
  const r = skillsIdSchema.safeParse(body);
  if (!r.success) {
    return { ok: false, error: 'invalid skill id', issues: r.error.issues };
  }
  return { ok: true, data: r.data };
}
```

```js
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function globalErrorHandler(err, req, res, _next) {
  console.error('[http:error]', err?.message || err);
  if (res.headersSent) return;
  res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || 'internal_error' });
}
```

---

## 6) 서버 구조 개선 계획 (왜 필요한지 포함)

### 6.1 `server.js` 분리 (현재 947줄)

왜 필요한가:
- 라우트가 하나의 파일에 집중되어 있어 변경 시 회귀 범위 예측이 어렵다.
- 입력 검증/응답 포맷이 파일 내 위치에 따라 편차가 발생한다.

대상 분리안:

| 파일 | 책임 | 이유 |
|---|---|---|
| `src/routes/core.js` | session/messages/runtime/command | 코어 세션 API 집중 |
| `src/routes/settings.js` | settings/prompt/heartbeat-md | 설정 쓰기 경로 격리 |
| `src/routes/memory.js` | memory/memory-files/claw-memory | 파일 경로 보안 집중 |
| `src/routes/integrations.js` | telegram/mcp/upload/quota | 외부 연동 오류 경계 분리 |
| `src/routes/employees.js` | employees/skills/heartbeat | 식별자 검증/DB 변경 집중 |
| `server.js` | 앱 초기화, 미들웨어 등록, start/stop | 부팅 전용 |

### 6.2 응답 계약 통일 (`ok/data/error`)

왜 필요한가:
- 클라이언트 분기 로직이 "배열인지 객체인지"를 엔드포인트마다 개별 처리하게 됨.
- 에러 응답 포맷이 섞여 있으면 텔레그램/웹/CLI 에러 표시에 중복 코드가 생김.

적용 정책:

| 케이스 | 표준 |
|---|---|
| 성공 (리스트/객체) | `{ ok: true, data: ... }` |
| 사용자 오류 | `{ ok: false, error: 'invalid_input', details? }` |
| 서버 오류 | `{ ok: false, error: 'internal_error' }` |

하위호환 전환 전략:
- 1단계: 기존 필드 유지 + `ok/data` 추가
- 2단계: 프런트 전환 완료 후 bare 응답 제거

### 6.3 위험 catch 정책 정리

왜 필요한가:
- 오류가 “숨겨진 성공”으로 바뀌면 운영에서 관측이 불가능하다.

정책:
- `process/file/network` 영역: 최소 `console.warn` 필수
- `initial boot fallback` 영역: 주석 + `console.debug` 허용
- `JSON parse` 영역: 로그 레벨 낮추되 발생 횟수 카운터 저장 고려

---

## 7) 보안 하드닝 포인트 (Phase 9 입력)

아래는 실제 코드에서 즉시 리스크가 보이는 엔드포인트다.

### 7.1 `memory-files` 라우트

현재 형태:
- `join(getMemoryDir(), req.params.filename)` 후 `.endsWith('.md')` 확인

문제:
- 파일명 자체 검증이 약함 (`../`, `..%2f`, 절대경로 변종 등)

개선:
- filename regex whitelist
- `resolve(base, filename)` 후 `resolved.startsWith(base + sep)` 강제

### 7.2 `skills` 라우트

현재 형태:
- `id`를 경로 결합해 파일 복사/삭제

문제:
- `id` 검증 부재 시 경로 조작 여지

개선:
- `^[a-z0-9][a-z0-9._-]*$` 강제
- `/`, `..`, `\` 포함 즉시 400

### 7.3 `upload` 라우트

현재 형태:
- `decodeURIComponent(x-filename)` 직후 저장

문제:
- 잘못된 percent-encoding 예외/헤더 타입 변형에 취약

개선:
- 안전 decode helper
- 파일명 길이 제한
- 허용 문자셋/확장자 정책

### 7.4 `claw-memory` read/save

현재 형태:
- `memory.read(req.query.file)` / `memory.save(req.body.file, ...)`

문제:
- 내부 함수에서 경로 결합 시 입력 검증이 약함

개선:
- file/path validator 도입
- memory API 전용 guard 적용

---

## 8) 우선순위 계획 (세부)

### P0 (보안/계약 최소선) — 0.5~1일

작업:
1. 입력 검증 유틸 추가 (`skills id`, `filename`, `path`)
2. memory-files/skills/upload/claw-memory 경로 가드 적용
3. 위험 catch 최소 로깅 추가

왜:
- 구조 분리보다 먼저 공격면 축소가 우선

검증:
- 악성 입력 케이스 400/403 보장
- 정상 입력 회귀 없음

### P1 (구조 분리) — 1~1.5일

작업:
1. `server.js` 라우트 그룹 분리
2. 응답 헬퍼 도입 (`ok`, `fail`)
3. bare 응답에 래퍼 적용(하위호환 모드)

왜:
- 이후 테스트 작성 난이도를 급격히 낮춤

검증:
- 라우트 스모크 테스트 통과
- route 등록 누락 0건

### P2 (테스트/커버리지) — 1~1.5일

작업:
1. path/validator 단위 테스트
2. orchestrator/agent 인자 테스트
3. coverage threshold 적용

왜:
- Phase 10+ 기능 변경 시 회귀 차단

검증:
- `npm test` + coverage 임계치 통과

### P3 (의존성 게이트 정착) — 0.5~1일

작업:
1. 오프라인 deps check 스크립트 추가
2. 온라인 deps check 스크립트 추가
3. semgrep baseline 절차 문서화

왜:
- 네트워크 편차가 있어도 최소 안전선 유지 필요

검증:
- 오프라인 스크립트는 항상 실행 가능
- 온라인 환경에서 audit/outdated/semgrep 산출물 생성 확인

---

## 9) 구현 체크리스트 (실행용)

### 9.1 보안 입력 검증

- [ ] `skills id` regex validator 추가
- [ ] `filename` whitelist validator 추가
- [ ] `safeResolve(base, input)` 유틸 추가
- [ ] `decodeFilenameSafe` 유틸 추가
- [ ] `/api/memory-files/:filename` guard 적용
- [ ] `/api/skills/*` guard 적용
- [ ] `/api/upload` guard 적용
- [ ] `/api/claw-memory/read` guard 적용
- [ ] `/api/claw-memory/save` guard 적용

### 9.2 응답/에러 공통화

- [ ] `src/http/response.js` 추가
- [ ] `src/http/async-handler.js` 추가
- [ ] `src/http/error-middleware.js` 추가
- [ ] `asyncHandler` 미들웨어 추가
- [ ] `globalErrorHandler` 추가
- [ ] 라우트별 `{ ok, data }` 전환 계획 반영

### 9.3 테스트

- [ ] `tests/unit/path-guards.test.js`
- [ ] `tests/unit/decode.test.js`
- [ ] `tests/unit/http-response.test.js`
- [ ] `tests/unit/async-handler.test.js`
- [ ] `tests/unit/orchestrator-parsing.test.js`
- [ ] `tests/unit/orchestrator-triage.test.js`
- [ ] `tests/unit/agent-args.test.js`
- [ ] `tests/unit/settings-merge.test.js`
- [ ] 커버리지 임계치 실행

### 9.4 의존성/정적분석

- [ ] `scripts/check-deps-offline.mjs`
- [ ] `scripts/check-deps-online.sh`
- [ ] semgrep baseline 실행/산출물 저장
- [ ] `devlog/260225_finness/static-analysis-baseline.md` 작성

---

## 10) 완료 기준 (Definition of Done)

필수:
- P0 악성 입력 테스트 모두 차단
- P1 라우트 분리 후 기능 회귀 없음
- P2 신규 테스트 + 기존 테스트 통과
- P3 오프라인 deps check 상시 통과

권장:
- 온라인 audit/outdated 결과 저장
- semgrep SARIF/JSON 산출물 저장
- catch 분류표(의도/비의도) 문서화

---

## 11) 위험/롤백

### 위험

| 위험 | 영향 | 대응 |
|---|---|---|
| 응답 포맷 변경으로 클라이언트 파손 | 중 | 하위호환 2단계 전환 |
| 경로 가드 과잉으로 정상 입력 차단 | 중 | whitelist를 파일명 규칙과 함께 튜닝 |
| 라우트 분리 중 import 누락 | 중 | route registration 스모크 테스트 |
| better-sqlite3 메이저 업글 회귀 | 중 | 별도 브랜치 + DB smoke test |

### 롤백

- 라우트 분리는 모듈 단위 커밋으로 쪼개서 되돌림 가능하게 유지
- 응답 계약은 feature flag 또는 dual response로 단계 적용
- 의존성 업그레이드는 lockfile-only 커밋으로 분리

---

## 12) Phase 9 착수 전 준비물

- 최신 브랜치 동기화 및 충돌 정리
- 테스트 실행 기준 고정 (`npm test`)
- 오프라인 deps check 스크립트 초안 추가
- 보안/검증 공통 모듈 파일 생성

---

## 13) 근거 링크 (Context7 + Web)

### Context7
- Express 4.21.2: async handler, global error middleware, body parser examples
  - https://context7.com/expressjs/express/llms.txt
- Zod: `safeParse`, coercion
  - https://github.com/colinhacks/zod/blob/main/packages/docs-v3/README.md
  - https://github.com/colinhacks/zod/blob/main/packages/docs/content/api.mdx
- Semgrep docs: `ci`, `--json`, `--sarif`, `--baseline-commit`
  - https://github.com/semgrep/semgrep-docs/blob/main/docs/getting-started/cli.md
  - https://github.com/semgrep/semgrep-docs/blob/main/src/components/reference/_cli-help-scan-output.md
  - https://github.com/semgrep/semgrep-docs/blob/main/release-notes/february-2022.md

### Websearch/공식 문서
- Express 보안 가이드
  - https://expressjs.com/en/advanced/best-practice-security.html
- Express 4.x API `res.sendFile`
  - https://expressjs.com/en/4x/api.html#res.sendFile
- npm audit
  - https://docs.npmjs.com/cli/v10/commands/npm-audit
- npm outdated
  - https://docs.npmjs.com/cli/v10/commands/npm-outdated
- Node CLI test coverage options
  - https://nodejs.org/api/cli.html
- GHSA (ws)
  - https://github.com/advisories/GHSA-3h5v-q93c-6h6q
- GHSA (node-fetch)
  - https://github.com/advisories/GHSA-r683-j2x4-v87g
- Express releases
  - https://github.com/expressjs/express/releases
- ws releases
  - https://github.com/websockets/ws/releases
- better-sqlite3 releases
  - https://github.com/WiseLibs/better-sqlite3/releases
- Playwright releases
  - https://github.com/microsoft/playwright/releases

---

## 14) 부록 A: 빠른 점검 명령 모음

```bash
# 1) 구조/규모
wc -l server.js src/*.js lib/*.js
rg -n "app\.(get|post|put|patch|delete)\('/api" server.js | wc -l

# 2) 예외 처리
rg -n "catch \{" server.js src lib tests -g'*.js'

# 3) 테스트
npm test
node --test tests/events.test.js

# 4) 의존성
npm ls --depth=0
npm ls node-fetch
node scripts/check-deps-offline.mjs

# 5) (네트워크 가능 시)
npm audit --json
npm outdated --json
semgrep ci --json --json-output semgrep.json
semgrep ci --sarif --sarif-output semgrep.sarif
```

---

## 15) 부록 B: 라우트 리스크 인덱스 (우선 보안)

| 우선순위 | 라우트 | 리스크 유형 | 조치 |
|---:|---|---|---|
| 1 | `GET /api/memory-files/:filename` | path traversal | whitelist + resolve guard |
| 1 | `DELETE /api/memory-files/:filename` | path traversal | whitelist + resolve guard |
| 1 | `POST /api/skills/enable` | path injection | id regex + segment deny |
| 1 | `POST /api/skills/disable` | path injection | id regex + segment deny |
| 1 | `GET /api/skills/:id` | path injection | id regex + segment deny |
| 2 | `POST /api/upload` | filename/header abuse | safe decode + length/type check |
| 2 | `GET /api/claw-memory/read` | arbitrary file read | file param guard |
| 2 | `POST /api/claw-memory/save` | arbitrary file append | file param guard |
| 3 | `PUT /api/employees/:id` | weak id validation | UUID regex check |
| 3 | `PUT /api/settings` | schema drift | schema validator |

---

## 16) 부록 C: catch 분류 기준표

| 유형 | 예시 | 허용 여부 | 요구사항 |
|---|---|---|---|
| 초기 파일 부재 fallback | `settings.json` 없음 | 허용 | 주석 + debug |
| 사용자 입력 파싱 실패 | query/body parse | 조건부 허용 | warn + 400 |
| 프로세스 제어 실패 | kill/spawn/IPC | 비권장 | warn/error + 상태 반영 |
| 외부 API 실패 | telegram/mcp/http | 비권장 | error + 5xx 응답 |
| 보안 검증 실패 | path/id 규칙 위반 | 허용 | info/warn + 4xx |


---

## 17) 부록 D: API 응답 정규화 매트릭스 (작성 시점 62개 라우트)

설명:
- `현재`는 기존 구현의 대표 응답 형식을 적었다.
- `목표`는 단계 전환 이후의 표준 형식이다.
- `우선`은 변경 우선순위다.

| # | Method | Route | 현재 | 목표 | 우선 |
|---:|---|---|---|---|---|
| 1 | GET | `/api/session` | bare object | `{ok,data}` | 중 |
| 2 | GET | `/api/messages` | bare array | `{ok,data}` | 중 |
| 3 | GET | `/api/runtime` | bare object | `{ok,data}` | 중 |
| 4 | POST | `/api/command` | result pass-through | `{ok,data}` | 중 |
| 5 | GET | `/api/commands` | bare array | `{ok,data}` | 중 |
| 6 | POST | `/api/message` | 혼합 (`ok`/`error`) | `{ok,data|error}` | 중 |
| 7 | POST | `/api/orchestrate/continue` | `{ok}` | `{ok,data}` | 낮음 |
| 8 | POST | `/api/stop` | `{ok,killed}` | `{ok,data}` | 낮음 |
| 9 | POST | `/api/clear` | `{ok}` | `{ok,data}` | 낮음 |
| 10 | GET | `/api/settings` | bare object | `{ok,data}` | 중 |
| 11 | PUT | `/api/settings` | bare object | `{ok,data}` | 중 |
| 12 | GET | `/api/prompt` | `{content}` | `{ok,data}` | 낮음 |
| 13 | PUT | `/api/prompt` | `{ok}` | `{ok,data}` | 낮음 |
| 14 | GET | `/api/heartbeat-md` | `{content}` | `{ok,data}` | 낮음 |
| 15 | PUT | `/api/heartbeat-md` | `{ok}` | `{ok,data}` | 낮음 |
| 16 | GET | `/api/memory` | bare array | `{ok,data}` | 중 |
| 17 | POST | `/api/memory` | `{ok}` | `{ok,data}` | 낮음 |
| 18 | DELETE | `/api/memory/:key` | `{ok}` | `{ok,data}` | 낮음 |
| 19 | GET | `/api/memory-files` | mixed object | `{ok,data}` | 상 |
| 20 | GET | `/api/memory-files/:filename` | `{name,content}` | `{ok,data}` | 상 |
| 21 | DELETE | `/api/memory-files/:filename` | `{ok}` | `{ok,data}` | 상 |
| 22 | PUT | `/api/memory-files/settings` | `{ok}` | `{ok,data}` | 상 |
| 23 | POST | `/api/upload` | `{path,filename}` | `{ok,data}` | 상 |
| 24 | POST | `/api/telegram/send` | `{ok,chat_id,type}` | `{ok,data}` | 중 |
| 25 | GET | `/api/mcp` | bare object | `{ok,data}` | 중 |
| 26 | PUT | `/api/mcp` | `{ok,servers}` | `{ok,data}` | 중 |
| 27 | POST | `/api/mcp/sync` | `{ok,results}` | `{ok,data}` | 중 |
| 28 | POST | `/api/mcp/install` | `{ok,results,synced}` | `{ok,data}` | 중 |
| 29 | POST | `/api/mcp/reset` | mixed object | `{ok,data}` | 중 |
| 30 | GET | `/api/cli-registry` | bare array/object | `{ok,data}` | 낮음 |
| 31 | GET | `/api/cli-status` | bare object | `{ok,data}` | 낮음 |
| 32 | GET | `/api/quota` | bare object | `{ok,data}` | 낮음 |
| 33 | GET | `/api/employees` | bare array | `{ok,data}` | 중 |
| 34 | POST | `/api/employees` | bare object | `{ok,data}` | 중 |
| 35 | PUT | `/api/employees/:id` | bare object | `{ok,data}` | 중 |
| 36 | DELETE | `/api/employees/:id` | `{ok}` | `{ok,data}` | 낮음 |
| 37 | POST | `/api/employees/reset` | `{ok,seeded}` | `{ok,data}` | 낮음 |
| 38 | GET | `/api/heartbeat` | bare object | `{ok,data}` | 낮음 |
| 39 | PUT | `/api/heartbeat` | bare object | `{ok,data}` | 낮음 |
| 40 | GET | `/api/skills` | bare array/object | `{ok,data}` | 상 |
| 41 | POST | `/api/skills/enable` | `{ok}` or error | `{ok,data|error}` | 상 |
| 42 | POST | `/api/skills/disable` | `{ok}` or msg | `{ok,data}` | 상 |
| 43 | GET | `/api/skills/:id` | markdown text | `{ok,data}` or raw 유지 | 상 |
| 44 | POST | `/api/skills/reset` | `{ok,symlinks}` | `{ok,data}` | 중 |
| 45 | GET | `/api/claw-memory/search` | `{result}` | `{ok,data}` | 상 |
| 46 | GET | `/api/claw-memory/read` | `{content}` | `{ok,data}` | 상 |
| 47 | POST | `/api/claw-memory/save` | `{ok,path}` | `{ok,data}` | 상 |
| 48 | GET | `/api/claw-memory/list` | `{files}` | `{ok,data}` | 상 |
| 49 | POST | `/api/claw-memory/init` | `{ok}` | `{ok,data}` | 상 |
| 50 | POST | `/api/browser/start` | bare object | `{ok,data}` | 낮음 |
| 51 | POST | `/api/browser/stop` | `{ok}` | `{ok,data}` | 낮음 |
| 52 | GET | `/api/browser/status` | bare object | `{ok,data}` | 낮음 |
| 53 | GET | `/api/browser/snapshot` | mixed object | `{ok,data}` | 낮음 |
| 54 | POST | `/api/browser/screenshot` | bare object | `{ok,data}` | 낮음 |
| 55 | POST | `/api/browser/act` | bare object | `{ok,data}` | 낮음 |
| 56 | POST | `/api/browser/vision-click` | bare object | `{ok,data}` | 낮음 |
| 57 | POST | `/api/browser/navigate` | bare object | `{ok,data}` | 낮음 |
| 58 | GET | `/api/browser/tabs` | `{tabs}` | `{ok,data}` | 낮음 |
| 59 | POST | `/api/browser/evaluate` | bare object | `{ok,data}` | 낮음 |
| 60 | GET | `/api/browser/text` | bare object | `{ok,data}` | 낮음 |

전환 전략:
- 상/중 우선 라우트부터 `{ok,data}` 변환
- 브라우저 계열은 프런트 병행 작업 시점에 동기화

---

## 18) 부록 E: catch 정리 백로그 (63건)

설명:
- 전수 수정이 아니라 “위험 catch 우선” 큐를 정의한다.
- `우선=상`은 이번 페이즈에서 반드시 처리한다.

| 파일 | 영역 | 현재 패턴 | 위험 | 조치 | 우선 |
|---|---|---|---|---|---|
| `server.js` | `/api/browser/tabs` | `catch { tabs:[] }` | 실패 은닉 | warn + 메트릭 카운트 | 상 |
| `server.js` | startup env load | `catch {}` | 낮음 | debug 주석 유지 | 낮음 |
| `server.js` | quota parse | `catch { return null; }` | 중 | warn once | 중 |
| `server.js` | telegram init patch | `catch {}` | 중 | warn + context | 상 |
| `src/orchestrator.js` | JSON parse | `catch {}` | 중 | debug + 입력 hash | 상 |
| `src/orchestrator.js` | subtask parse fallback | `catch {}` | 중 | warn when repeated | 상 |
| `src/orchestrator.js` | optional helpers | `catch {}` | 낮음 | 주석 명확화 | 낮음 |
| `src/agent.js` | kill SIGTERM | `catch {}` | 중 | warn with pid | 상 |
| `src/agent.js` | kill SIGKILL | `catch {}` | 중 | warn with pid | 상 |
| `src/agent.js` | non-json line | `catch {}` | 낮음 | debug level | 낮음 |
| `src/telegram.js` | bot stop | `catch {}` | 중 | warn with reason | 상 |
| `src/telegram.js` | parse/media | `catch {}` | 중 | warn + message id | 상 |
| `src/config.js` | loadSettings | `catch { default }` | 낮음 | debug + file path | 낮음 |
| `src/config.js` | heartbeat file read | `catch { jobs:[] }` | 낮음 | debug + path | 낮음 |
| `src/acp-client.js` | shutdown | `catch {}` | 낮음 | debug + ignore reason | 낮음 |
| `src/memory.js` | grep search | `catch { no results }` | 중 | warn on proc.error | 중 |
| `lib/mcp-sync.js` | registry parse | `catch {}` | 중 | warn + skip reason | 중 |
| `lib/mcp-sync.js` | bin detection | `catch {}` | 낮음 | debug only | 낮음 |

실행 룰:
- 상: 즉시 수정
- 중: Phase 9 내 처리
- 낮음: 주석/문서화 후 보류 가능

---

## 19) 부록 F: 의존성 라이프사이클 정책

### 19.1 월간 점검 규칙

- 월 1회: `npm outdated` 결과 스냅샷
- 월 1회: GHSA 신규 advisory 확인
- 분기 1회: major 업그레이드 후보 검토

### 19.2 위험 등급

| 등급 | 기준 | 예시 조치 |
|---|---|---|
| Critical | 원격 코드 실행/권한 상승 | 24시간 내 핫픽스 |
| High | DoS/민감정보 누출 | 72시간 내 패치 |
| Medium | 조건부 취약점 | 주간 배치 |
| Low | 영향 제한 | 월간 배치 |

### 19.3 업그레이드 프로토콜

1. advisory 영향 범위 확인
2. lockfile 변경만 적용
3. 테스트 + 스모크 실행
4. 실패 시 즉시 lockfile 롤백

### 19.4 메이저 업그레이드 별도 트랙

- `better-sqlite3`는 native 모듈이므로 별도 브랜치에서 진행
- 체크:
  - Node 버전 호환
  - DB read/write smoke
  - 마이그레이션 루틴
  - WAL/SHM 파일 동작

### 19.5 문서화 포맷

```md
# Dependency Review - YYYY-MM

## Snapshot
- node:
- npm:
- lock hash:

## Advisory
1. package / advisory / impact / action

## Upgrade Candidates
1. package / current / target / risk / owner

## Decision
- apply now:
- defer:
```

---

## 20) 부록 G: 운영 체크리스트 (배포 전/후)

### 배포 전

- [ ] `node scripts/check-deps-offline.mjs` 통과
- [ ] `npm test` 통과
- [ ] 고위험 라우트 보안 케이스 통과
- [ ] 응답 계약 변경 리스트 점검
- [ ] 롤백 커밋 포인트 기록

### 배포 직후

- [ ] 에러 로그 급증 여부 확인
- [ ] 4xx/5xx 비율 관찰
- [ ] Telegram/MCP 라우트 정상 동작 확인
- [ ] memory/skills 관련 사용자 플로우 샘플 확인

### 배포 24시간

- [ ] 문제 재현 리포트 수집
- [ ] false positive guard 조정
- [ ] 문서 상태 업데이트

---

## 21) 부록 H: Phase 9 착수 인수인계 노트

Phase 9 담당자가 바로 시작할 수 있도록 아래를 선행 공유한다.

1. 현재 지표
- 500줄 초과 파일 5개
- API 라우트 62개 (작성 시점)
- catch 63건
- 테스트 파일 9개

2. 즉시 해야 할 것
- WS1 보안 가드 구현 + 테스트
- WS2 공통 응답/에러 도입

3. 병렬 가능한 것
- WS4 테스트 작성
- WS5 deps script 준비

4. 병목 예상
- route 분리 충돌
- 응답 계약 변경 여파

5. 우회 전략
- PR 분할
- dual response
- lockfile-only commits


---

## 22) CMD Line · Telegram · Web · CLI 통합 감사 (AGENTS/agent md 참조)

요청 반영:
- `cmd line / telegram / web / cli` 커맨드 체계를 별도 축으로 감사함.
- 참조 문서:
  - `cli-claw/AGENTS.md`
  - `cli-claw/devlog/str_func/AGENTS.md`
  - `cli-claw/devlog/str_func/commands.md`
  - `cli-claw/devlog/str_func/agent_spawn.md`

핵심 참조 규칙(`str_func/AGENTS.md`):
- 커맨드/API 변경 시 `src/commands.js`, `server.js`, `bin/commands/chat.js`, `src/telegram.js`를 동시 점검해야 함.
- CLI 서브커맨드 변경 시 `bin/cli-claw.js`의 `printHelp`와 switch case를 동기화해야 함.

### 22.1 현재 통합 구조 맵

| 인터페이스 | 진입점 | 커맨드 파싱/실행 | Help 소스 | 비고 |
|---|---|---|---|---|
| CMD line (root) | `bin/cli-claw.js` | subcommand switch | `printHelp()` 하드코딩 | Slash registry와 분리 |
| CLI Chat (REPL) | `bin/commands/chat.js` | `parseCommand` + `executeCommand` | `/help` (`src/commands.js`) | WebSocket + HTTP 혼합 |
| Web | `public/js/features/chat.js` + `/api/command` | 서버에서 `parse/execute` | `/help` + `/api/commands` | dropdown은 `/api/commands?interface=web` |
| Telegram | `src/telegram.js` | `parse/execute` | `/help` + `setMyCommands` | menu는 일부 command 제외 |

### 22.2 실제 갭 (중요)

1. root help와 slash help가 이원화됨
- `bin/cli-claw.js` 도움말은 수동 텍스트.
- `src/commands.js`는 동적 registry.
- 결과: help 내용 불일치 위험.

2. root help 누락
- 실제 switch에 있는 `browser`, `memory`가 `printHelp()` Commands 블록에 누락됨.
- 사용자 관점에서 "명령이 있는데 도움말엔 없는" 상태 발생.

3. Telegram 메뉴와 `/help` 정보 불일치
- `setMyCommands`는 `TG_EXCLUDED_CMDS(model, cli)` 제외.
- 그러나 `/help`는 telegram interface 기준으로 `model`, `cli`를 계속 표시.
- Telegram ctx에서는 설정 변경이 제한되어 `/model`, `/cli`가 사실상 안내만 가능.

4. Web 자동완성은 command-level prefix만 지원
- 현재 dropdown은 `filterCommands(/prefix)`만 수행.
- `src/commands.js`에 있는 `getArgumentCompletionItems` 기능이 Web에서 미사용.

5. 인터페이스 capability 정책이 분산
- `makeWebCommandCtx`, `makeCliCommandCtx`, `makeTelegramCommandCtx`에 권한/지원 범위가 분산.
- 동일 명령이 인터페이스마다 어떤 모드(readonly/blocked/full)인지 중앙정의가 없음.

6. `/api/commands` 메타가 최소치
- name/desc/args/category만 전달.
- aliases, readonly, hidden reason, examples, interface policy가 없어 도움말/자동완성 확장이 어려움.

### 22.3 스킬 기준으로 본 해석

| 스킬 | 요구/근거 | 현재 상태 | 개선 필요 |
|---|---|---|---|
| `dev` | Self-reference 3계층(Skill→API→CLI), 모듈화 | 일부 충족 | help/catalog 단일소스화 필요 |
| `dev-backend` | 일관된 API/응답 계약 | `/api/commands`는 bare array | `{ok,data}` + 확장 메타 권장 |
| `dev-testing` | 회귀 테스트 루프 | 인터페이스 parity 테스트 없음 | help/command parity test 필요 |
| `telegram-send` | Bot-first 정책 + local fallback | 전송 경로는 구현됨 | command help/메뉴 정책과 통합 필요 |
| `web-routing` | 브라우저 요청 분기 단순화 | `/browser` 명령 존재 | help에 분기 힌트 추가 필요 |
| `browser` | snapshot→action 패턴 가시화 | command desc 단문 | help 상세에 workflow 안내 필요 |

### 22.4 감사 결론 (통합/Help 축)

- 기능은 이미 공유 레지스트리(`src/commands.js`) 중심으로 절반 이상 통합되어 있음.
- 하지만 **도움말/노출 정책/자동완성 정책**이 인터페이스별로 분리되어 “인지 부채”가 남아 있음.
- Phase 9에서 이를 "Command Contract v2"로 명확히 통합해야 한다.

---

## 23) Command Contract v2 제안 (Phase 9 입력)

### 23.1 목표

1. 명령 정의 단일소스화
2. 인터페이스 capability 명시화 (`full`, `readonly`, `hidden`, `blocked`)
3. Help 출력 일관화 (root/cli/web/tg 동일 정책)
4. 자동완성 일관화 (command + args)

### 23.2 제안 스키마

```ts
interface CommandSpec {
  name: string;
  aliases?: string[];
  desc: string;
  args?: string;
  category: 'session' | 'model' | 'tools' | 'cli';
  interfaces: ('cli'|'web'|'telegram'|'cmdline')[];
  capability?: Partial<Record<'cli'|'web'|'telegram'|'cmdline', 'full'|'readonly'|'hidden'|'blocked'>>;
  examples?: string[];
  handler: Function;
}
```

### 23.3 Help 출력 정책

- `/help` 기본: 현재 interface에서 `hidden/blocked` 제외 항목만 표시
- `/help <cmd>`: 지원 interface + capability + 예시까지 표시
- `cli-claw --help`/`cli-claw help`: 동일 catalog에서 root command 목록 생성
- Telegram `setMyCommands`: 동일 policy에서 `full/readable` 항목만 반영

### 23.4 Web 자동완성 정책

- 현재: `/prefix` 필터링
- 목표:
  - command completion: 서버 `getCompletionItems` 결과 사용
  - argument completion: 서버 `getArgumentCompletionItems` 결과 사용
  - `/help` 인라인 힌트 표시

---

## 24) 통합 검증 스니펫 (parity check)

### 24.1 command/help parity 스크립트 예시

```js
#!/usr/bin/env node
import { COMMANDS } from '../src/commands.js';

const RESERVED = new Set(['start', 'id', 'help', 'settings']);
const TG_EXCLUDED = new Set(['model', 'cli']);

const byIface = (iface) => COMMANDS
  .filter(c => c.interfaces.includes(iface) && !c.hidden)
  .map(c => c.name)
  .sort();

const telegramHelp = byIface('telegram').filter(name => !RESERVED.has(name));
const telegramMenu = COMMANDS
  .filter(c => c.interfaces.includes('telegram') && !RESERVED.has(c.name) && !TG_EXCLUDED.has(c.name))
  .map(c => c.name)
  .sort();

const missingInMenu = telegramHelp.filter(x => !telegramMenu.includes(x));

console.log('[parity] telegram help:', telegramHelp);
console.log('[parity] telegram menu:', telegramMenu);

if (missingInMenu.length) {
  console.error('[parity] mismatch (help only):', missingInMenu.join(', '));
  process.exit(1);
}

console.log('[parity] ok');
```

### 24.2 실행 명령

```bash
node scripts/check-command-parity.mjs
```

권장:
- CI에서 `npm test` 앞에 parity check를 붙여 메뉴/도움말 드리프트를 차단.

---

## 25) 통합 축 우선순위 (Phase 9와 결합)

1. P0
- Telegram help/menu mismatch 해소
- root help 누락 수정 (`browser`, `memory`)

2. P1
- Command capability map 도입
- `/api/commands` 메타 확장

3. P2
- Web argument completion 연결
- parity test + snapshot test 추가

4. P3
- docs/AGENTS/str_func 동기화 자동 체크

완료 기준:
- 인터페이스별 command 목록과 help output이 정책상 완전히 일치
- "보이지만 실행 불가" 명령 0건
