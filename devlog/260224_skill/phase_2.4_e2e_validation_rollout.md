# Phase 2.4 — E2E 검증 및 롤아웃 계획

> 목표: 2.1~2.3 설계를 실제 운영 전에 검증 가능한 테스트/배포 절차로 정리한다.
> 범위: 코드 구현이 아니라 테스트 명세, 관측 포인트, 롤백 전략 문서화.

---

## 검증 전략

2.4의 핵심은 "성공 케이스"보다 "실패 시 안전성"이다. 특히 Telegram 파일 전송은 외부 API 의존이므로 네트워크/권한/포맷 오류를 기본값으로 가정하고 테스트해야 한다.

---

## E2E 테스트 매트릭스

### A. `telegram-send` API

1. `type=text` JSON 요청
- 기대: Telegram 텍스트 메시지 수신

2. `type=voice` + `file_path`
- 기대: 음성 메시지 재생 가능

3. `type=photo` + `file_path` + `caption`
- 기대: 사진 + 캡션 동시 수신

4. `type=document` + `file_path`
- 기대: 문서 다운로드 가능

5. `type=invalid`
- 기대: `400` + 명시적 에러 메시지

6. `chat_id` 미지정 + active chat 없음
- 기대: `400` (`No active Telegram chat`)

### B. 음성 입력(STT)

1. Telegram에서 짧은 음성 입력
- 기대: STT 결과를 텍스트로 회신

2. 손상 파일/다운로드 실패
- 기대: 실패 알림 텍스트 + 로그 기록

3. 긴 음성 입력(임계치 초과)
- 기대: 정책대로 분할 또는 안내 메시지

---

## 관측(Observability) 체크리스트

- [ ] 요청마다 `type`, `chat_id`, 처리시간(ms), 결과(status)를 로그로 남김
- [ ] Telegram API 실패 코드(4xx/5xx) 원문 요약 로깅
- [ ] STT 단계 소요시간/실패율 분리 집계
- [ ] 에러 로그에 민감정보(토큰, 절대경로 전체) 노출 금지

---

## 롤아웃 단계

1. Local Dry Run
- 단일 chat_id, 수동 curl 호출 중심

2. Canary
- 실제 사용 chat 1개에서 24시간 관찰
- 실패율/재시도율 확인

3. General Availability
- 프롬프트 지침 활성화
- 서브에이전트에도 동일 정책 적용

4. Rollback
- `/api/telegram/send` 비활성화 플래그 준비
- 프롬프트에서 파일 전송 지시 블록 제거 가능 상태 유지

---

## 사전 체크 (외부 스펙 기준)

Telegram 파일 업로드는 multipart가 필요하고, 일반 API 호출은 JSON 형태를 사용한다. E2E 테스트는 content-type별 케이스를 분리해 검증해야 한다.
> 출처: [Telegram Bot API - Making requests](https://core.telegram.org/bots/api#making-requests)

`sendVoice` 포맷 허용 범위(OGG OPUS, MP3, M4A)는 테스트 fixture 준비에 직접 영향을 준다.
> 출처: [Telegram Bot API - sendVoice](https://core.telegram.org/bots/api#sendvoice)

Express 기본 파서와 Multer 책임 범위가 다르므로 multipart 테스트는 미들웨어 구성 여부를 전제로 분기해야 한다.
> 출처: [Express body-parser](https://expressjs.com/en/resources/middleware/body-parser.html), [Multer README](https://github.com/expressjs/multer#usage)

---

## 완료 기준 (Definition of Done)

- [ ] A/B 테스트 매트릭스 전 항목 실행 결과 기록
- [ ] 실패 시나리오 3종(네트워크, 포맷, 권한) 재현 완료
- [ ] Canary 24시간 모니터링 결과 문서화
- [ ] 롤백 절차 리허설 1회 완료
