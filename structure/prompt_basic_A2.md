---
created: 2026-03-28
tags: [cli-jaw, prompt, user-config, template]
aliases: [A2 user prompt, CLI-JAW A2, user config prompt]
---

> 📚 [INDEX](INDEX.md) · [프롬프트 흐름 ↗](prompt_flow.md) · [A1](prompt_basic_A1.md) · **A2 사용자 설정** · [B](prompt_basic_B.md)

# prompt_basic_A2 — 사용자 설정 프롬프트

> 경로: `~/.cli-jaw/prompts/A-2.md`
> 소스: `src/prompt/templates/a2-default.md` (25L)
> 구현: `src/prompt/builder.ts` → `getA2Default()`, `initPromptFiles()`, `getSystemPrompt()`
> 생성 조건: 파일이 없을 때만 자동 생성, 기존 파일은 절대 덮어쓰지 않음

---

## 현재 동작

`A-2.md`는 사용자 설정용 보조 프롬프트다. 현재 구현에서는 `getSystemPrompt()`가 A1 다음에 A2를 이어 붙이고, `initPromptFiles()`는 `A-2.md`가 없을 때만 기본 템플릿을 생성한다.

즉, A2는 "코드 상수"가 아니라 "파일 기반 기본값"이다. 파일이 없으면 `getSystemPrompt()`는 빈 문자열로 처리하지만, 정상 초기화 경로에서는 `initPromptFiles()`가 기본 파일을 먼저 만들어 둔다.

---

## 기본 템플릿

`a2-default.md`는 아주 짧은 정적 기본값이다. 핵심 섹션은 다음 네 개다.

- `Identity`: 에이전트 이름과 이모지
- `User`: 사용자 이름, 언어, 시간대
- `Vibe`: 말투와 정확도 톤
- `Working Directory`: 에이전트가 참고하는 기본 작업 디렉토리

```markdown
# User Configuration

## Identity
- Name: Jaw
- Emoji: 🦈

## User
- Name: (your name)
- Language: English
- Timezone: UTC

## Vibe
- Friendly, warm
- Technically accurate

## Working Directory
- ~/.cli-jaw
```

---

## 중요한 구분

| 항목 | 의미 |
|---|---|
| `settings.workingDir` | 실제 CLI 실행/기록에 쓰이는 작업 경로 |
| A2의 `Working Directory` | 프롬프트에 노출되는 참고 정보 |

둘은 같은 값이 아닐 수 있다. A2는 "사용자에게 보이는 기본 힌트"이고, 실제 런타임 경로는 설정과 세션 컨텍스트가 결정한다.
