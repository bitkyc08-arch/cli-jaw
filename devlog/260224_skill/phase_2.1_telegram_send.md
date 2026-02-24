# Phase 2.1 — `telegram-send` API 고정안 (2026-02-24)

> 목적: CLI 에이전트가 일반 텍스트 채널과 분리된 경로로 Telegram 파일(voice/photo/document)을 전송하도록 API 계약을 고정한다.
> 상태: 사용자 보고 기준으로 Step 1은 완료. 이 문서는 Step 1을 깨지 않도록 계약을 정리하고 Step 2+가 붙을 수 있게 기준을 고정한다.

---

## 핵심 정리

`/api/telegram/send`는 "비텍스트 산출물 전송용 보조 채널"이다. 일반 응답은 기존 stdout/NDJSON 파이프라인을 그대로 사용하고, 파일 전송이 필요한 경우만 별도 REST 호출을 사용한다. `type=text`는 헬스체크/중간 알림용으로만 제한적으로 허용한다.

Telegram Bot API는 일반 JSON 요청과 파일 업로드 요청(`multipart/form-data`)을 구분해서 다룬다. 따라서 API 설계에서 content-type 경로를 명시적으로 분리해야 한다.
> 출처: [Telegram Bot API - Making requests](https://core.telegram.org/bots/api#making-requests)

Express 기본 파서는 `json/urlencoded/raw/text` 중심이고 multipart는 별도 미들웨어가 필요하다. 그래서 `upload.single('file')` 경로를 유지하려면 Multer 같은 미들웨어를 명시해야 한다.
> 출처: [Express body-parser (multipart 비권장/별도 모듈 안내)](https://expressjs.com/en/resources/middleware/body-parser.html), [Multer README](https://github.com/expressjs/multer#usage)

---

## 아키텍처

```text
CLI agent
├── 일반 응답 → stdout (NDJSON) → orchestrator → Telegram 텍스트 (기존)
└── 파일 전송 요청 → POST /api/telegram/send → grammY(bot.api.*) → Telegram 파일/음성
```

---

## API 계약 (고정안)

### 엔드포인트

- `POST /api/telegram/send`

### 지원 타입

- 기본 지원: `voice`, `photo`, `document`
- 호환 지원: `text` (헬스체크/중간 알림용)

grammY 기준으로 `bot.api.sendMessage/sendVoice/sendPhoto/sendDocument` 모두 `InputFile` 또는 파일 식별자를 사용할 수 있다.
> 출처: [grammY Guide - Files](https://grammy.dev/guide/files), [grammY API](https://grammy.dev/ref/core/api)

### 요청 포맷

1. `application/json`
- `type=text` + `text` 필수
- 또는 `type in [voice,photo,document]` + `file_path` 필수

2. `multipart/form-data` (선택 경로)
- `type in [voice,photo,document]` + `file` 필수
- 이 경로를 쓰려면 Multer가 서버에 명시적으로 있어야 한다

### 채팅 선택 규칙

권장 기본 정책:

- `chat_id`는 요청에서 필수
- 누락 시 `400`

호환 정책(선택):

- `chat_id` 미지정 시 `lastActiveChatId` 같은 별도 상태를 사용
- 이 값은 `message:text|photo|document|voice` 이벤트마다 갱신

주의:

`telegramActiveChatIds`(`Set`)만으로는 "최근 활성 채팅"을 정확히 표현할 수 없다. `Set`은 삽입 순서를 유지하지만, 이미 존재하는 chat_id를 다시 `add`해도 순서를 갱신하지 않기 때문이다.
> 출처: [MDN - Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)

대안:

- 1:1 응답 모델이면 `chat_id` 필수 정책이 가장 안전
- 다중 채팅 브로드캐스트 모델이면 `heartbeat`처럼 활성 chat 전체 순회 전송

### 음성 포맷 규칙

Telegram `sendVoice`는 OGG(OPUS), MP3, M4A를 허용한다. 다만 음성 메모 UX 일관성을 위해 OGG+OPUS를 권장 포맷으로 둔다.
> 출처: [Telegram Bot API - sendVoice](https://core.telegram.org/bots/api#sendvoice)

### 에러 규약

- `503`: Telegram bot 미연결
- `400`: `chat_id` 미결정, 필수 필드 누락, 지원하지 않는 `type`
- `500`: Telegram API 호출 실패, 파일 접근 실패

### 런타임 네트워크 제약

Telegram bot 인스턴스는 `ipv4Fetch`를 사용하도록 구성되어 있다. `/api/telegram/send`는 반드시 이 인스턴스(`telegramBot`)를 재사용해야 네트워크 동작이 일관된다.

---

## Step 1 완료 정의 (문서 기준)

Step 1을 "완료"로 보기 위한 최소 조건:

1. 라우트 존재: `POST /api/telegram/send`
2. `type` 분기 처리: `text|voice|photo|document`
3. `chat_id` 정책 명시(`chat_id` 필수 또는 `lastActiveChatId` 별도 상태 기반)
4. 실패 시 명시적 HTTP 상태코드 반환

아래는 Step 1 이후에도 남는 안정화 항목(Phase 2.2+)이다.

- multipart 경로 채택 여부 확정 (`multer` 도입 vs `file_path` 고정)
- 입력 검증 강화 (`text`/`file_path`/`caption` 길이)
- 경로 검증(임의 경로 접근 방지)

---

## 검증 시나리오 (2.1 범위)

1. Telegram에서 아무 메시지 1회 수신해서 active chat 확보
2. `type=text` JSON 전송 → 텍스트 수신 확인
3. `type=voice` + `file_path` 전송 → 음성 수신/재생 확인
4. `type=photo` + `file_path` + `caption` 전송 → 이미지/캡션 확인
5. `type=document` + `file_path` 전송 → 파일명/다운로드 확인
6. 잘못된 `type` 전송 → `400` 확인
7. `chat_id` 누락 요청 → `400` 확인 (필수 정책 기준)

---

## 체크리스트

- [x] `POST /api/telegram/send` 엔드포인트 (사용자 보고 기준 완료)
- [ ] `type`/필수필드/에러코드 검증 표준화
- [ ] multipart 경로 사용 여부 최종 결정
- [ ] 파일 경로 보안 검증 규칙 추가
- [ ] 2.1 범위 테스트 로그 문서화

---

## 참고 (Context7 + 공식 문서)

grammY에서 `InputFile` 기반 파일 전송과 `bot.api.*` 호출 패턴은 Context7 색인과 공식 가이드가 동일하게 설명한다.
> 출처: [Context7 - grammY](https://context7.com/grammyjs/website/llms.txt), [grammY Guide - Files](https://grammy.dev/guide/files)

Express 본체와 Multer 책임 범위(기본 파서 vs multipart 업로드)는 Context7 색인과 공식 문서가 일치한다.
> 출처: [Context7 - Express](https://context7.com/expressjs/express/llms.txt), [Context7 - Multer](https://context7.com/expressjs/multer), [Multer README](https://github.com/expressjs/multer#usage)
