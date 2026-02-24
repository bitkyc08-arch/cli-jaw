# Phase 3 (P3): CLI 자동설치 + README 대규모 개편 + 테스트 확장

> 작성일: 2026-02-25
> 상태: ✅ 완료

## 배경
- postinstall에서 MCP(context7), playwright, uv는 자동설치하면서 핵심 CLI 도구(claude, codex, gemini, opencode, copilot)는 미포함이었음
- README가 한국어 위주로 작성되어 있었고, 설치 가이드가 `npm install -g cli-claw` 한 줄뿐이었음
- 테스트 상세가 README에 섞여 있어 문서 과부하

## 변경 내역

### 1. postinstall.js — 5-CLI 자동설치
- `bun --version` 감지 → bun 있으면 `bun install -g`, 없으면 `npm i -g` 폴백
- 4개 npm 패키지 자동설치: `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, `opencode-antigravity-auth`
- copilot: 기존 `gh copilot --help` + symlink 로직 유지, 에러 메시지 개선
- 이미 설치된 CLI는 `which` 체크로 스킵

### 2. README 3개 언어 대규모 개편
- **EN** (`README.md`): Quick Start → Getting Started 3단계 (Install → Auth → Run)
- **KR** (`README.ko.md`): 완전 번역본, 자연스러운 톤
- **CN** (`README.zh-CN.md`): 완전 번역본, 활기 있는 톤
- 각 파일 상단에 언어 스위처 (`English / 한국어 / 中文`)
- 모델 섹션: "Preconfigured Models & Custom Input" — 프리셋일 뿐, 아무 ID나 입력 가능 명시
- 스크린샷 placeholder: Web UI, Terminal TUI, Telegram Bot 3곳

### 3. TESTS.md 분리
- README에서 테스트 상세 제거 → `TESTS.md`로 이동
- README에는 `npm test` 한 줄 + 링크만

### 4. 테스트 확장 (별도 커밋)
- `tests/unit/cli-registry.test.js` — 8 tests
- `tests/unit/bus.test.js` — 6 tests
- `tests/unit/commands-parse.test.js` — 15 tests
- `tests/unit/worklog.test.js` — 5 tests
- **총 65 tests / 0 fail / ~90ms**

## 수정 파일
- `bin/postinstall.js` — 5-CLI 자동설치 추가
- `README.md` — 영문 개편
- `README.ko.md` — 한국어 완전 번역
- `README.zh-CN.md` — 중국어 완전 번역
- `TESTS.md` — 신규 (테스트 상세 분리)
- `tests/unit/*.test.js` — 4개 신규 테스트 파일
- `tests/plan.md` — 검증 결과 업데이트

## 후속 버그픽스 (같은 날)

| 우선순위 | 이슈 | 수정 |
|:--------:|------|------|
| **P0** | opencode 패키지 `opencode-antigravity-auth`는 bin 필드 없음 → `which opencode` 실패 | `opencode-ai`로 교체 (bin: `bin/opencode` 확인) |
| **P1** | bun 실패 시 npm 폴백 없음 — 설치 실패로 종료 | per-package `npm i -g` 재시도 로직 추가 |
| **P1** | `doctor.js`가 4개 CLI만 검사 (copilot 누락) | `['claude','codex','gemini','opencode','copilot']` 5개로 확장 |
| **P2** | 문서 테스트 수 65로 남아있음 (실제 70) | README×3 + TESTS.md 전부 70으로 동기화 |

