---
created: 2026-02-24
status: planning
tags: [cli-claw, finness, backend, security, testing]
---
# Phase 9: 백엔드 하드닝 + API 안정화 (프런트 제외)

> 목표: `dev / dev-backend / dev-data / dev-testing` 기준으로, Phase 8에서 다루지 못한 백엔드 리스크를 제거하고 회귀 테스트를 추가
> 범위: `server.js`, `src/*.js`, `lib/*.js`, `tests/` (프런트 파일 제외)

---

## dev 스킬 명시 연관 스킬 점검 결과

`dev`에서 추가 탐색 대상으로 적힌 스킬들을 실제 확인했고, 백엔드 범위에 맞는 항목만 본 페이즈에 반영:

1. `security-best-practices` (Express 레퍼런스)
- 핵심 근거: untrusted input 검증, path/redirect 검증, 에러/헤더 하드닝은 MUST 수준
- 반영: P0 경로/ID 검증 하드닝, P1 공통 응답/검증 유틸

2. `static-analysis` (README + semgrep scanner/triager)
- 핵심 근거: Semgrep 기반 정적분석 + triage 절차, SARIF 산출
- 반영: P2에 `semgrep baseline + triage` 추가

3. `tdd`
- 핵심 근거: "failing test first" RED-GREEN-REFACTOR
- 반영: P2 테스트 작업은 테스트 선작성 원칙으로 진행

4. `debugging-checklist`
- 핵심 근거: 재현 → 범위격리 → 최소 프로브
- 반영: P1/P2 디버깅 시 과도 로깅 대신 저위험 점검 우선

5. `postgres`
- 이 프로젝트는 SQLite 중심(`better-sqlite3`)이라 직접 적용 대상 아님

6. `react-best-practices`, `web-perf`
- 프런트엔드 범주라 이번 페이즈(프런트 제외)에서는 제외

> 참고: `static-analysis`는 일반 SKILL 단일 파일이 아니라 플러그인 구조(`README.md`, `agents/*.md`)로 제공됨

---

## Phase 8 검토 결과 (요약)

1. **유효한 진단**
- 500줄 초과 파일(5개) 지적은 현재 코드와 일치 (`server.js`, `src/commands.js`, `src/agent.js`, `src/orchestrator.js`, `src/prompt.js`)
- 라우트 분리/핸들러 분리 방향성도 타당

2. **보정 필요**
- `catch {}` 건수는 현재 기준 **43건보다 많음** (동일 범위 재집계 시 증가)
- 보안성 입력 검증(경로/ID/path traversal)이 핵심 이슈인데 Phase 8 본문에 누락됨
- 일부 계획 항목은 최신 코드 반영이 필요함 (`tests/*.test.js`, `npm run test*`는 이미 존재)

---

## 핵심 개선 포인트 (프런트 제외)

### P0. 경로/ID 검증 하드닝 (보안)

1. `memory-files` 경로 검증 추가
- 대상: `server.js` (`/api/memory-files/:filename`)
- 문제: `join()` + 확장자 체크만으로는 상위 경로 탈출 시도를 완전히 차단하지 못함
- 조치: `resolve(base, input)` 후 `base` 하위 여부 강제 검증, 파일명 패턴 화이트리스트 적용

2. `skills` API ID 검증 추가
- 대상: `server.js` (`/api/skills/enable`, `/disable`, `/:id`)
- 문제: `id`를 경로에 바로 결합해 파일 읽기/삭제 경로가 열림
- 조치: `^[a-z0-9][a-z0-9._-]*$` 패턴 강제 + 경로 구분자(`/`, `..`) 즉시 차단

3. 업로드 헤더 파싱 방어
- 대상: `server.js` (`/api/upload`)
- 문제: `decodeURIComponent()` 예외와 헤더 타입 불일치 방어가 약함
- 조치: 안전 decode helper 도입(실패 시 400), 파일명 길이/문자셋 제한

완료 기준:
- traversal/invalid id 입력이 모두 `400` 또는 `403`으로 거절
- 정상 케이스 동작은 기존과 동일

### P1. API 계약/에러 처리 정돈

1. 응답/에러 헬퍼 도입
- 대상: 신규 `src/http-response.js`
- 조치: `ok(res, data, extra)` / `fail(res, code, message)` 공통화

2. 위험한 silent catch 최소 로깅
- 대상: `server.js`, `src/orchestrator.js`, `src/agent.js`, `src/telegram.js`
- 조치: 의도된 fallback은 주석 유지, 비의도 무시는 `console.warn` 추가

3. 입력 검증 유틸 분리
- 대상: 신규 `src/http-validate.js`
- 조치: route 내부 ad-hoc 검증 제거, 재사용 가능한 validator로 이동

완료 기준:
- 신규/수정 라우트는 공통 헬퍼 사용
- silent catch 정책이 파일별로 일관화

### P2. 테스트 보강 (백엔드만)

1. 경로 가드 단위 테스트
- 대상: `tests/unit/path-guards.test.js`
- 케이스: 정상 파일명, `../` 탈출, 절대경로, 빈 문자열

2. API 검증 테스트
- 대상: `tests/unit/http-validate.test.js`
- 케이스: skills id, upload filename, memory filename 검증

3. 회귀 테스트 확장
- 대상: `tests/unit/orchestrator.test.js`, `tests/unit/agent-args.test.js`
- 케이스: JSON 파싱 실패 fallback, CLI 인자 조합 회귀

4. 정적분석 베이스라인 추가
- 대상: `src/`, `lib/`, `server.js` (프런트 제외)
- 작업: semgrep JSON/SARIF 결과 생성 후 true/false positive triage
- 산출: `devlog/260225_finness/static-analysis-baseline.md` (요약 리포트)

완료 기준:
- `npm run test` 통과
- P0/P1 변경점 관련 실패 재현 케이스가 테스트에 포함
- 정적분석 결과가 문서화되고, false positive/후속 수정 대상이 분리됨

---

## 구현 파일 계획

- `server.js` (route 검증/에러 처리 반영)
- `src/path-guards.js` (신규)
- `src/http-validate.js` (신규)
- `src/http-response.js` (신규)
- `tests/unit/path-guards.test.js` (신규)
- `tests/unit/http-validate.test.js` (신규)
- `tests/unit/orchestrator.test.js` (신규)
- `tests/unit/agent-args.test.js` (신규)

---

## 난이도 및 예상 기간

- 난이도: **중상 (★★★☆☆ ~ ★★★★☆)**
- 예상: **1.5~3일**
  - P0: 0.5~1일
  - P1: 0.5~1일
  - P2: 0.5~1일
