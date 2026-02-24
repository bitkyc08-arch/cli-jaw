# Phase 2.2 — `telegram-send` 스킬/프롬프트/레지스트리 연결

> 목표: 2.1에서 고정한 API를 실제 에이전트 사용 경로에 연결한다.
> 범위: 코드 구현이 아니라 "연결 설계와 완료 기준" 문서화.

---

## 왜 2.2가 필요한가

2.1은 서버 API 계약만 정한다. 하지만 실제로는 에이전트가 해당 API를 발견하고, 호출하고, 사용자에게 함께 텍스트 보고를 해야 한다. 즉 2.2는 "발견 가능성(스킬/레지스트리) + 실행 지시(프롬프트)"를 묶는 단계다.

---

## 산출물

1. `skills_ref/telegram-send/SKILL.md`
2. `skills_ref/registry.json` 항목 추가
3. `src/prompt.js` 시스템/서브에이전트 지침 추가
4. 기존 설치 사용자 프롬프트 마이그레이션 전략

---

## 1) SKILL.md 설계

### 최소 Frontmatter

```yaml
---
name: telegram-send
description: "Send files, voice messages, photos, or documents directly to Telegram via local API."
metadata:
  openclaw:
    emoji: "📨"
    requires:
      bins: ["curl"]
---
```

### 반드시 포함할 명령

- `type=text` JSON 예제 1개
- `type=voice/photo/document` + `file_path` 예제
- (선택) multipart 예제는 서버가 Multer 경로를 채택했을 때만 포함

### 규칙 문구

- 파일 전송 시에도 최종 텍스트 응답은 반드시 함께 제공
- 사용자가 명시 요청했거나 태스크 특성상 파일 전달이 필수일 때만 사용
- 실패 시(`4xx/5xx`) 텍스트로 원인 보고

---

## 2) `skills_ref/registry.json` 등록

### 항목 예시

```json
"telegram-send": {
  "name": "Telegram Send",
  "emoji": "📨",
  "category": "communication",
  "description": "텔레그램으로 voice/photo/document 직접 전송"
}
```

### 경로 주의

`prompt.js` 로더는 런타임에서 `~/.cli-claw/skills_ref/registry.json`을 읽으므로, 저장소의 `skills_ref/registry.json` 변경이 설치 경로로 복사되는 흐름까지 같이 봐야 한다.

---

## 3) 시스템 프롬프트 반영

### 반영 위치

- `A1_CONTENT` (기본 템플릿)
- `getSubAgentPrompt` (서브에이전트도 동일 지시)

### 반드시 들어갈 정책

1. 일반 텍스트는 기존 파이프라인 사용
2. 비텍스트 전달은 `/api/telegram/send` 사용
3. 파일 전송 후에도 텍스트 요약을 별도로 남길 것

### 예시 블록

```markdown
## Telegram File Delivery
Use Telegram Send API only for non-text outputs (voice/photo/document).
Always include a normal text response summarizing what was sent.
```

---

## 4) 프롬프트 마이그레이션 (중요)

`initPromptFiles()`는 `A-1.md`가 없을 때만 생성한다. 따라서 기존 설치 사용자에게는 `A1_CONTENT` 수정만으로 즉시 반영되지 않는다. 2.2 완료 기준에는 "기존 사용자 반영 방식"을 반드시 포함해야 한다.

추가 확인:

- 런타임 프롬프트 생성(`getSystemPrompt`)은 상수 `A1_CONTENT`를 직접 쓰지 않고, 실제 파일 경로 `A1_PATH`를 읽는다.
- 즉 "소스 코드 상수 변경만으로 기존 사용자에게 자동 반영"은 성립하지 않는다.

권장안:

1. 서버 시작 시 `A-1.md`에 섹션 유무를 점검
2. 없으면 안전하게 append
3. 이미 있으면 중복 삽입 금지

---

## 완료 기준 (Definition of Done)

- [ ] `skills_ref/telegram-send/SKILL.md` 작성
- [ ] `skills_ref/registry.json` 등록
- [ ] `A1_CONTENT` + `getSubAgentPrompt` 지침 추가
- [ ] 기존 사용자용 `A-1.md` 반영 전략 문서화
- [ ] "파일 전송 + 텍스트 응답 동시 제공" 테스트 시나리오 작성

---

## 검증 포인트 (Context7/공식)

grammY는 `bot.api.sendPhoto/sendDocument`에 `InputFile`과 caption 옵션을 함께 받는 형태를 공식 가이드에서 제시한다.
> 출처: [Context7 - grammY](https://context7.com/grammyjs/website/llms.txt), [grammY Guide - Files](https://grammy.dev/guide/files)

multipart 업로드는 Multer의 `upload.single(field)`에서 `req.file` + `req.body`로 결합 처리한다.
> 출처: [Context7 - Multer](https://context7.com/expressjs/multer), [Multer README](https://github.com/expressjs/multer#usage)
