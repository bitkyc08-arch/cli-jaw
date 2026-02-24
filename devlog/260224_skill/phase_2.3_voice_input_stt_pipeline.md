# Phase 2.3 — Telegram 음성 입력(STT) 파이프라인

> 목표: Telegram 음성 메시지를 받아 텍스트 질의로 변환하는 경로를 정의한다.
> 원칙: 2.1/2.2에서 만든 "파일 전송 보조 채널"과 충돌하지 않게, 수신 파이프라인은 독립적으로 유지한다.

---

## 설계 방향

음성 입력은 기존 이미지/문서 업로드 흐름과 같은 철학으로 처리한다.

1. Telegram에서 파일 수신
2. 서버가 파일 다운로드/저장
3. 에이전트가 STT 스킬(`transcribe`)을 사용해 텍스트화
4. 텍스트를 일반 응답 파이프라인으로 회신

---

## 이벤트 및 포맷 근거

grammY는 `bot.on("message:voice")` 필터를 통해 음성 메시지를 분기할 수 있다.
> 출처: [grammY Guide - Update Filters](https://grammy.dev/guide/filter-queries), [Context7 - grammY](https://context7.com/grammyjs/website/llms.txt)

Telegram `Voice` 객체는 음성 메모를 `.ogg`(OPUS)로 설명한다. 수신 파이프라인은 이 기본 포맷을 우선 가정하고, 필요 시 변환 단계를 둔다.
> 출처: [Telegram Bot API - Voice](https://core.telegram.org/bots/api#voice)

---

## 처리 플로우

```text
Telegram voice message
→ bot.on("message:voice")
→ downloadTelegramFile(file_id)
→ saveUpload(..., "voice.ogg")
→ build prompt with saved file path
→ transcribe skill (Whisper 등) 실행
→ text result를 일반 응답 채널로 송신
```

---

## 구현 옵션 (문서 단계 결정)

### 옵션 A: 스킬 기반 STT (권장)

- 서버는 파일 저장까지만 담당
- 실제 STT는 에이전트가 `transcribe` 스킬로 수행
- 장점: 서버 OpenAI 의존 최소화, 현재 스킬 체계 재사용

### 옵션 B: 서버 `/api/transcribe` 추가 (선택)

- 서버가 직접 STT API 호출
- 장점: 단일 API로 완결
- 단점: 서버 책임/보안/키 관리 범위 증가

현 시점 기본안은 옵션 A, 옵션 B는 Phase 2.3b로 분리 권장.

---

## 실패 시나리오와 대응

1. 파일 다운로드 실패
- 사용자에게 `파일 수신 실패` 텍스트 즉시 응답
- 에러 로그에 `chat_id`, `file_id` 앞부분, HTTP status 기록

2. STT 호출 실패
- 재시도 1회 후 실패 시 텍스트로 원인 전달
- 원본 파일 경로를 임시 보관(짧은 TTL)하여 수동 재처리 가능하게 함

3. 긴 음성(비용/시간 증가)
- 길이 임계치 정책(예: 3~5분 초과시 분할/요약 모드) 문서화

---

## 완료 기준 (Definition of Done)

- [ ] `message:voice` 핸들러 설계 확정
- [ ] 저장 경로/파일명/정리 정책(보관 기간) 정의
- [ ] STT 옵션 A(스킬 기반) 실행 시퀀스 문서화
- [ ] 실패/재시도/타임아웃 정책 문서화
- [ ] 음성 입력 E2E 테스트 케이스 작성

---

## 검증 포인트

파일 수신-재전송 시나리오에서 grammY의 `InputFile`/파일 핸들링 모델은 송수신 모두 일관된 패턴을 제공한다.
> 출처: [Context7 - grammY](https://context7.com/grammyjs/website/llms.txt), [grammY Guide - Files](https://grammy.dev/guide/files)
