---
created: 2026-03-28
tags: [cli-jaw, prompt, system-prompt, template]
aliases: [A1 system prompt, CLI-JAW A1, system prompt template]
---

> 📚 [INDEX](INDEX.md) · [프롬프트 흐름 ↗](prompt_flow.md) · **A1 시스템 규칙** · [A2](prompt_basic_A2.md) · [B](prompt_basic_B.md)

# prompt_basic_A1 — 시스템 프롬프트 기본값

> 경로: `~/.cli-jaw/prompts/A-1.md`
> 소스: `src/prompt/templates/a1-system.md` (275L)
> 구현: `src/prompt/builder.ts` → `getA1Content()` / `initPromptFiles()` / `getSystemPrompt()`
> 파일 우선: `A-1.md`가 있으면 사용자 편집본 사용, 없으면 템플릿 렌더 결과 사용
> `A1_CONTENT` 상수는 더 이상 없음

---

## 현재 로딩 방식

| 단계 | 동작 | 코드 |
|---|---|---|
| 1 | `A-1.md` 존재 시 파일 내용을 그대로 사용 | `getSystemPrompt()` |
| 2 | `A-1.md`가 없으면 `a1-system.md`를 렌더링해서 사용 | `getA1Content()` |
| 3 | 첫 설치 시 `initPromptFiles()`가 `A-1.md`와 `.hash`를 생성 | `initPromptFiles()` |
| 4 | 해시가 달라졌을 때 사용자 편집본이면 보존, stock 파일이면 새 템플릿으로 이관 | `resolveLegacyA1Migration()` |

> 핵심은 "파일 우선, 템플릿 폴백"이다. 예전처럼 코드 상수 하나로 고정된 구조가 아니다.

---

## 템플릿 구조

`a1-system.md`는 시스템 프롬프트의 정적 골격을 담당한다. 현재 템플릿은 다음 축으로 구성된다.

- `Rules`: 응답 언어, 결과 보고, git 안전장치, 짧고 구조적인 Markdown
- `Fail fast`: 실패를 숨기지 말고 즉시 보고
- `Web search first`: 버전/오류/API 질문은 검색을 우선
- `jaw Employees vs CLI Sub-agents` + `When to Use Which`: Boss dispatch와 CLI 내부 sub-agent를 구분
- `How jaw Works (Architecture)`: Boss/employee 흐름과 `$computer-use` 토큰, `cli-jaw dispatch` 타임아웃
- `Desktop / Browser Control (MANDATORY)`: `$computer-use` 트리거, Control 디스패치 템플릿, 빠른 `cli-jaw browser` CDP/Web UI 경로, Codex/Control Computer Use 경로, Codex-only vision-click fallback, transcript format, forbidden 항목
- `Channel File Delivery` (+ Discord notes): 로컬 채널 API, Telegram bot API curl 예시
- `Long-term Memory (MANDATORY)`: `{{JAW_HOME}}/memory/structured/` 경로와 `cli-jaw memory ...` 명령, 저장 가이드
- `Heartbeat System`: `heartbeat.json` 자동 재로드
- `Development Rules` + `Dev Skills`: ES Module, 500줄 제한, try/catch, 작업 전 `dev/SKILL.md` 읽기
- `Diagrams (MANDATORY)`: 다이어그램·SVG·Mermaid를 위한 skill 우선 규칙과 인라인 전달 규칙

---

## 리셋/수정 기준

| 상황 | 결과 | 자동 복구? |
|---|---|---|
| `A-1.md` 삭제 | `a1-system.md` 렌더본으로 재생성 | ✅ |
| `A-1.md` 내용 수정 | 수정본 그대로 사용 | ✅ |
| stock 템플릿 변경 | `.hash` 기준으로 stock 여부를 다시 판정 | ✅ |
| 사용자 커스텀 파일 | 해시가 달라도 보존 | ✅ |

> `A-1.md`는 설정 파일이 아니라 사용자 편집 가능한 시스템 프롬프트 캐시다. `getSystemPrompt()`는 이 파일을 최상단에 그대로 붙이고, 동적 섹션(memory injection, orchestration, heartbeat, skills, vision-click, delegation rules)을 그 뒤에서 추가한다. 이전에 A1 다음에 붙던 timestamp stamp(`YYMMDD-HH:MMAM/PM.`)는 현재 코드에서 제거됐다.
