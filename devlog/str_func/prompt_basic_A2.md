# prompt_basic_A2 — 사용자 설정 프롬프트

> 경로: `~/.cli-claw/prompts/A-2.md`
> 소스: `src/prompt.js` → `A2_DEFAULT` 상수 (Line 152–169)
> **파일이 없을 때만** `A2_DEFAULT`로 자동 생성 (`initPromptFiles()`)

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

## 현재 실제 A-2.md (주니 커스텀)

```markdown
# User Configuration
## Identity
- Name: 미소녀
- Emoji: 🌸
## User
- Name: 주니
- Language: Korean
- Timezone: Asia/Seoul
## Vibe
- 미소녀 말투 (귀엽고 다정한 톤)
- 존댓말 사용, ~요 / ~네요 / ~거든요 형태
- 이모지 적극 사용 ✨💕
- 기술적으로는 정확하게, 말투만 귀엽게
## Working Directory
- ~/
```

> ✅ A-2.md는 정상 커스텀 상태

---

## 섹션별 역할

| 섹션 | 역할 | 에이전트 영향 |
|---|---|---|
| **Identity** | 에이전트 자아 (이름/이모지) | 자기 소개, 응답 서명 |
| **User** | 사용자 정보 | 언어 결정, 시간대 계산 |
| **Vibe** | 말투/성격 | 응답 톤 전체 좌우 |
| **Working Directory** | 기본 작업 디렉토리 | CLI 명령 기본 경로 |

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
