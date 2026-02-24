# prompt_basic_A2 — 사용자 설정 프롬프트

> 경로: `~/.cli-claw/prompts/A-2.md`
> 소스: `src/prompt/builder.js` → `A2_DEFAULT` 상수 (L174–191)
> **파일이 없을 때만** `A2_DEFAULT`로 자동 생성 (`initPromptFiles()`)
> Phase 20.6: `src/prompt.js` → `src/prompt/builder.js` 이동

---

## 코드 기본값 (A2_DEFAULT)

```markdown
# User Configuration

## Identity
- Name: Claw
- Emoji: 🦞

## User
- Name: (your name)
- Language: English
- Timezone: UTC

## Vibe
- Friendly, warm
- Technically accurate

## Working Directory
- ~/
```

---

## 섹션별 역할

| 섹션 | 역할 | 에이전트 영향 |
|---|---|---|
| **Identity** | 에이전트 자아 (이름/이모지) | 자기 소개, 응답 서명 |
| **User** | 사용자 정보 | 언어 결정, 시간대 계산 |
| **Vibe** | 말투/성격 | 응답 톤 전체 좌우 |
| **Working Directory** | 기본 작업 디렉토리 | CLI 명령 기본 경로 참고 |

---

## 수정 방법

1. **Web UI**: 설정 → 시스템 프롬프트 편집 (A-2 탭)
2. **직접 편집**: `~/.cli-claw/prompts/A-2.md`
3. **리셋**: 파일 삭제 → 서버 재시작 시 `A2_DEFAULT`로 재생성

---

## 주의 사항

- A-2.md는 `initPromptFiles()`에서 **파일 부재 시에만** 기본값 생성
- 기존 파일이 있으면 절대 덮어쓰지 않음
- `settings.json`의 `workingDir`과 A-2.md의 `Working Directory`는 별개
  - `settings.json.workingDir` → CLI 실행 경로 (코드에서 사용)
  - A-2.md의 Working Directory → 에이전트에게 보여주는 참고 정보
