# Phase 20: 전체 프로젝트 감사 — 최종 개선 로드맵

> Phase 9(백엔드 하드닝) 완료 가정 하에, cli-claw 프로젝트 전반을 감사한 결과.
> 216 tests pass / 0 fail 기준.

---

## 감사 범위

| 영역 | 파일 수 | 총 LOC |
|---|---|---|
| Backend (server.js + src/) | ~20 | ~5,500 |
| Frontend (public/js/) | ~15 | ~2,300 |
| CLI (bin/) | ~12 | ~1,800 |
| Library (lib/) | 1 | 645 |
| Tests | ~25 | ~1,800 |
| **합계** | ~73 | **~12,000** |

---

## 🔴 P0 — 즉시 수정 (안정성/보안)

### 20.1 server.js Graceful Shutdown 없음

```
현재: SIGTERM/SIGINT 핸들러 없음 (serve.js에만 child.kill 존재)
위험: 프로세스 종료 시 DB 커넥션/WebSocket 비정상 종료, 데이터 유실 가능
```

**조치:**
```js
// server.js 하단에 추가
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => {
    console.log(`[server] ${sig} received, shutting down...`);
    stopHeartbeat();
    killActiveAgent('shutdown');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000); // force after 5s
}));
```

**영향:** server.js 1곳
**위험도:** 높음 (데이터 유실)

---

### 20.2 Frontend fetch 에러 미처리 (~15곳)

```
현재: public/js/ 에서 fetch() 호출 시 .catch 없이 await만 사용
      네트워크 에러 시 Unhandled Promise Rejection → 조용한 실패
예시:
  - ui.js L129: const msgs = await (await fetch('/api/messages')).json();
  - employees.js L9: state.employees = await (await fetch('/api/employees')).json();
  - memory.js L5: const r = await fetch('/api/memory-files');
```

**조치:** 공통 fetch 래퍼 생성
```js
// public/js/api.js (NEW)
export async function api(path, opts = {}) {
    try {
        const res = await fetch(path, opts);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return await res.json();
    } catch (e) {
        console.warn('[api]', path, e.message);
        return null;
    }
}
```

**영향:** public/js/ 전체, ~15곳 교체
**위험도:** 중간 (UX 깨짐)

---

### 20.3 WebSocket 재연결 시 상태 복원 없음

```
현재: ws.js onclose → 2초 후 connect() 재호출만 함
문제: 재연결 후 기존 agent 실행 상태, 메시지 히스토리 동기화 없음
      → UI에 빈 화면 표시될 수 있음
```

**조치:** 재연결 후 `/api/session` + `/api/messages` 재로드

**영향:** public/js/ws.js
**위험도:** 중간 (UX)

---

## 🟡 P1 — 500줄 초과 파일 분리 (dev 스킬 위반)

| 파일 | LOC | 500줄 초과 | 분리 방안 |
|---|---|---|---|
| `server.js` | 949 | +449 | 9.3에서 6모듈 분리 예정 (완료 시 해결) |
| `bin/commands/chat.js` | 844 | +344 | CLI 렌더러, 키바인딩, 상태관리 3분할 |
| `src/commands.js` | 658 | +158 | 핸들러 그룹별 분리 (system/agent/config) |
| `lib/mcp-sync.js` | 645 | +145 | read/write/install 3분할 |
| `src/agent.js` | 619 | +119 | spawn + buildArgs + upload 분리 |
| `src/orchestrator.js` | 584 | +84 | parser + triage + orchestrate 분리 |
| `public/js/features/settings.js` | 532 | +32 | 렌더러 + 핸들러 분리 |
| `src/prompt.js` | 512 | +12 | 섹션 빌더 분리 가능 |

**총 8개 파일** 500줄 초과. dev 스킬 기준 위반.

---

## 🟢 P2 — 코드 품질 개선

### 20.4 CommonJS 잔존 (2곳)

```
bin/commands/chat.js:36  → const APP_VERSION = _require('../../package.json').version;
src/config.js:12         → const pkg = require('../package.json');
```

ESM 프로젝트에서 `createRequire` 사용. `import.meta.resolve` + `fs.readFile`로 전환하거나, `config.js`에서만 version export 하고 chat.js는 그걸 import.

**조치:** chat.js에서 `import { APP_VERSION } from '../../src/config.js'` 사용 (이미 export됨)

---

### 20.5 localhost 하드코딩 (6개 파일)

```
bin/commands/memory.js:6   → const SERVER = `http://localhost:${process.env.PORT || 3457}`;
bin/commands/browser.js:10 → const SERVER = `http://localhost:${process.env.PORT || 3457}`;
bin/commands/status.js:16  → 직접 URL 조립
bin/commands/reset.js:54   → 직접 URL 조립
bin/commands/employee.js:49 → 직접 URL 조립
bin/commands/chat.js:32-33 → wsUrl/apiUrl 직접 조립
```

**조치:** `src/config.js`에 `getServerUrl(port)`, `getWsUrl(port)` 추가, 각 CLI에서 import

---

### 20.6 console.log 남발 (backend 71곳)

운영 환경에서 로그 레벨 구분 없이 `console.log` 사용.

**조치:** 간단한 로거 모듈 도입
```js
// src/logger.js (NEW)
const LEVEL = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVEL[process.env.LOG_LEVEL || 'info'];
export const log = {
    debug: (...a) => current <= 0 && console.debug(...a),
    info:  (...a) => current <= 1 && console.log(...a),
    warn:  (...a) => current <= 2 && console.warn(...a),
    error: (...a) => current <= 3 && console.error(...a),
};
```

---

### 20.7 Express 보안 미들웨어 부재

```
현재: express.json() + express.static()만 등록
부재:
  - helmet (HTTP 헤더 보안)
  - CORS 정책 (현재 전체 허용)
  - Rate limiting (API 남용 방지)
  - Request size limit (express.json 기본 100kb이지만 명시적 설정 없음)
```

**조치:**
- `helmet` 추가 (의존성 1개)
- CORS는 localhost 전용이므로 명시적 origin 설정
- Rate limit는 `express-rate-limit` 또는 자체 구현 (IP당 분당 60회)

---

## 🔵 P3 — 프론트엔드 개선

### 20.8 innerHTML XSS 표면 (~15곳)

```
현재: innerHTML 사용처 ~15곳
      escapeHtml() 사용처: 잘 적용된 곳 ✅
      DOMPurify: CDN 로드, sanitizeHtml() 구현됨 ✅
      미적용 의심:
        - employees.js L20: innerHTML에 a.role 직접 삽입 가능 (escapeHtml 누락 가능성)
        - heartbeat.js L23: job 데이터 innerHTML 삽입
        - skills.js L32: 스킬 데이터 innerHTML 삽입
```

**조치:** 모든 innerHTML 삽입 경로에 `escapeHtml()` 적용 확인 + 미적용 건 수정

---

### 20.9 Accessibility 미흡

```
현재: 커맨드 드롭다운에만 ARIA 적용
부재:
  - sidebar 버튼들 aria-label 없음
  - 모달 dialog 역할 정의 없음
  - 키보드 네비게이션 불완전 (Tab 순서)
  - 색상 대비 미검증
```

**조치:** 주요 인터랙션 포인트에 ARIA + role 추가 (점진)

---

### 20.10 Mobile 반응형 미검증

```
현재: viewport meta ✅, CSS var 사용 ✅
미확인:
  - 사이드바 모바일 오버레이 동작
  - 터치 이벤트 처리
  - 화면 <768px 레이아웃
```

---

## 🟣 P4 — 테스트/CI 강화

### 20.11 테스트 커버리지 측정 없음

```
현재: 216 tests pass
부재: --experimental-test-coverage 미사용
      어떤 파일/함수가 커버되는지 모름
```

**조치:**
```json
// package.json scripts 추가
"test:coverage": "node --test --experimental-test-coverage tests/*.test.js tests/**/*.test.js"
```

---

### 20.12 Integration 테스트 부재

```
현재: unit 테스트 위주 (순수 함수 파싱/검증)
부재:
  - API 엔드포인트 smoke test (supertest)
  - WebSocket 연결/메시지 테스트
  - CLI 커맨드 E2E 테스트
  - 프런트엔드 테스트
```

**조치:**
- `supertest` 또는 직접 fetch로 API smoke test 10개+
- CLI 기본 동작 확인 (--help, version, 존재하지 않는 명령)

---

### 20.13 CI 파이프라인 최소

```
현재: test.yml → npm ci + npm test만
부재:
  - Lint (ESLint)
  - check:deps 오프라인 게이트
  - 500줄 초과 파일 경고
  - PR 템플릿
```

**조치:** CI에 `npm run check:deps` + 파일 크기 체크 추가

---

## ⚪ P5 — 구조/인프라 개선

### 20.14 package.json files 필드 불완전

```json
"files": ["bin/", "server.js", "public/", "package.json"]
```

`src/`, `lib/`, `skills_ref/` 누락 → npm publish 시 **서버 실행 불가**

**조치:** `"files": ["bin/", "server.js", "src/", "lib/", "public/", "skills_ref/"]`

---

### 20.15 devDependencies 없음

```
현재: 모든 의존성이 dependencies에
      playwright-core는 런타임에만 브라우저 제어용 → 맞음
      but: 테스트/개발 도구가 없음 (ESLint, supertest 등)
```

---

### 20.16 설정 마이그레이션 전략 없음

```
현재: settings.json 스키마 변경 시 수동 대응
      기존 사용자 설정 파일과 신규 필드 충돌 가능
```

**조치:** `src/settings-merge.js`에 version 필드 + 마이그레이션 함수 추가

---

### 20.17 에러 바운더리 없음 (Frontend)

```
현재: JS 에러 시 화면 완전 정지
부재: window.onerror / unhandledrejection 핸들러
```

**조치:**
```js
// public/js/main.js 최상단
window.addEventListener('unhandledrejection', e => {
    console.error('[unhandled]', e.reason);
    e.preventDefault();
});
```

---

## 📋 우선순위 정리

| 등급 | ID | 제목 | 난이도 | 영향 |
|---|---|---|---|---|
| 🔴 P0 | 20.1 | Graceful Shutdown | 쉬움 | 안정성 |
| 🔴 P0 | 20.2 | Frontend fetch 에러 처리 | 중간 | UX/안정성 |
| 🔴 P0 | 20.3 | WS 재연결 상태 복원 | 중간 | UX |
| 🟡 P1 | — | 500줄 초과 8파일 분리 | 높음 | 유지보수 |
| 🟢 P2 | 20.4 | CommonJS 제거 | 쉬움 | 일관성 |
| 🟢 P2 | 20.5 | localhost 하드코딩 제거 | 쉬움 | 유지보수 |
| 🟢 P2 | 20.6 | 로거 모듈 도입 | 쉬움 | 관측성 |
| 🟢 P2 | 20.7 | Express 보안 미들웨어 | 중간 | 보안 |
| 🔵 P3 | 20.8 | innerHTML XSS 감사 | 중간 | 보안 |
| 🔵 P3 | 20.9 | Accessibility 개선 | 중간 | 접근성 |
| 🔵 P3 | 20.10 | Mobile 반응형 | 중간 | UX |
| 🟣 P4 | 20.11 | 테스트 커버리지 | 쉬움 | 품질 |
| 🟣 P4 | 20.12 | Integration 테스트 | 높음 | 품질 |
| 🟣 P4 | 20.13 | CI 확장 | 중간 | 자동화 |
| ⚪ P5 | 20.14 | npm files 수정 | 쉬움 | 배포 |
| ⚪ P5 | 20.15 | devDependencies 정리 | 쉬움 | 구조 |
| ⚪ P5 | 20.16 | 설정 마이그레이션 | 중간 | 호환성 |
| ⚪ P5 | 20.17 | Frontend 에러 바운더리 | 쉬움 | 안정성 |

---

## 추천 실행 순서

### Round 1 (빠른 승리 — 1회)
- 20.1 Graceful Shutdown
- 20.4 CommonJS 제거
- 20.5 localhost 중앙화
- 20.14 npm files 수정
- 20.17 Frontend 에러 바운더리

### Round 2 (안정성 — 1~2회)
- 20.2 Frontend fetch 래퍼
- 20.3 WS 재연결 복원
- 20.6 로거 도입

### Round 3 (구조 — 2~3회)
- P1 500줄 파일 분리 (9.3 연장선)
- 20.7 Express 보안 미들웨어

### Round 4 (품질)
- 20.11 커버리지 측정
- 20.12 Integration 테스트
- 20.13 CI 확장

### Round 5 (폴리시)
- 20.8 innerHTML 감사
- 20.9 Accessibility
- 20.10 Mobile

---

## 감사 기준 출처

- `dev` 스킬: 500줄 제한, ESM 필수, export 보호, try/catch 필수
- `security-best-practices` (ref skill): 입력검증, CORS, 헤더보안
- `static-analysis` (ref skill): 코드 품질, 일관성
- Node.js 22 LTS 표준 + Express 4.x 보안 가이드

---

## 현재 건강 상태 요약

```
✅ 잘 된 것:
  - 216 tests / 0 fail — 안정적
  - ESM 전환 거의 완료 (2곳 제외)
  - DOMPurify + escapeHtml → XSS 방어 기반 있음
  - 보안 가드(9.1) + ok/fail 모듈(9.2) + deps gate(9.7)
  - i18n 인프라(한/영 전환)
  - 테마 시스템 + 사이드바 접기
  - CI 기본 셋업 (GitHub Actions)
  - config.js 중앙화 잘 됨

⚠️ 개선 필요:
  - server.js 949줄 모놀리식 (9.3 해결 예정)
  - 500줄 초과 파일 8개
  - frontend fetch 에러 처리 전무
  - graceful shutdown 없음
  - integration 테스트 없음
  - Express 보안 미들웨어 없음
```
