# Phase 2 — 텔레그램 전송 스킬 + 음성 인식 (구상)

> 구현 전 설계 기록. 두 기능은 독립적으로 개발 가능.
> 본 문서는 초기 구상본이며, 상세 실행안은 `phase_2.1`~`phase_2.4` 문서로 분리됨.

---

## 1. `telegram-send` 스킬 (CLI → 텔레그램 직접 전송)

### 패턴

브라우저 스킬과 동일 — CLI가 서버 REST API를 직접 호출.

```
CLI → curl localhost:3457/api/telegram/send \
       -F file=@/tmp/response.ogg \
       -F type=voice
     → server.js → Grammy → 텔레그램 즉시 전송
```

일반 텍스트 응답(stdout → NDJSON)과 **별개 채널**이므로 충돌 없음.

### 구현 항목

| 작업           | 파일                                | 내용                                                                       |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| API 엔드포인트 | `server.js`                         | `POST /api/telegram/send` — type(text/voice/photo/document), file, caption |
| chat_id 관리   | `server.js`                         | 현재 텔레그램 세션의 chat_id 자동 주입 (마지막 수신 메시지에서)            |
| 스킬 문서      | `skills_ref/telegram-send/SKILL.md` | curl 사용법, 지원 타입, 예제                                               |
| 레지스트리     | `registry.json`                     | 등록 (category: communication)                                             |

### 스킬 SKILL.md 초안

```yaml
---
name: telegram-send
description: "텔레그램으로 파일/음성/이미지 직접 전송. CLI에서 curl로 서버 API 호출."
---
```

```bash
# 음성 메시지 전송
curl -s -X POST http://localhost:3457/api/telegram/send \
  -F type=voice -F file=@/tmp/response.ogg

# 이미지 전송 (캡션 포함)
curl -s -X POST http://localhost:3457/api/telegram/send \
  -F type=photo -F file=@/tmp/chart.png -F caption="분석 결과"

# 텍스트 전송 (일반 응답과 별도)
curl -s -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"중간 결과 알림"}'
```

### 유스케이스

- TTS 결과물을 음성 메시지로 전송 (사용자 요청 시에만)
- 생성된 이미지/PDF/차트를 텔레그램으로 직접 전달
- 중간 결과물 선전송 + 최종 텍스트 응답 분리

---

## 2. 음성 인식 — STT 핸들러 (서버단)

### 패턴

이미지 첨부와 동일 — 파일 다운로드 후 프롬프트에 경로 포함.

```
텔레그램 음성(OGG) → bot.on("message:voice")
  → downloadTelegramFile() → /tmp/voice_xxx.ogg
  → 프롬프트: "사용자가 음성 메시지를 보냈습니다: /tmp/voice_xxx.ogg"
  → CLI가 transcribe 스킬로 Whisper API 호출 → 텍스트 추출 → 응답
```

### 구현 항목

| 작업          | 파일            | 내용                                                 |
| ------------- | --------------- | ---------------------------------------------------- |
| 음성 핸들러   | `telegram.js`   | `bot.on("message:voice")` — OGG 다운로드             |
| 파일 다운로드 | `lib/upload.js` | 기존 `downloadTelegramFile()` 활용                   |
| 프롬프트 전달 | `telegram.js`   | 파일 경로를 prompt에 포함 (이미지와 동일)            |
| 스킬 활성화   | 설정            | `transcribe` 스킬 활성화 (이미 `skills_ref/`에 존재) |

### 별도 API 옵션 (고급)

CLI가 직접 STT를 요청할 수 있도록:

```bash
# CLI에서 음성 파일을 텍스트로 변환
curl -s http://localhost:3457/api/transcribe \
  -F file=@/tmp/voice.ogg
# → {"text": "안녕하세요, 오늘 날씨 어때?"}
```

---

## 의존성

| 항목              | 필요      | 비고                                         |
| ----------------- | --------- | -------------------------------------------- |
| `openai` npm      | ✅         | Whisper + TTS API 호출                       |
| `ffmpeg`          | 선택      | mp3→ogg 변환 (텔레그램 음성은 OGG+OPUS 필수) |
| `OPENAI_API_KEY`  | ✅         | Whisper / TTS 둘 다 필요                     |
| `transcribe` 스킬 | 이미 존재 | `skills_ref/transcribe/`                     |
| `speech` 스킬     | 이미 존재 | `skills_ref/speech/`                         |

## 체크리스트

- [ ] `POST /api/telegram/send` 엔드포인트
- [ ] `telegram-send` SKILL.md + registry 등록
- [ ] `telegram.js` 음성 메시지 핸들러
- [ ] `POST /api/transcribe` 엔드포인트 (선택)
- [ ] 테스트: 음성 수신 → 텍스트화 → 응답
- [ ] 테스트: 텍스트 → TTS → 음성 전송
