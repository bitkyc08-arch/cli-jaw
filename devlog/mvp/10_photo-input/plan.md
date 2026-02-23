# Phase 10: 사진/이미지 인풋

openclaw 패턴: `bot-handlers.ts` → `message:photo` → `getFile()` → 다운로드 → 에이전트에 경로 전달

## 구현

- [x] 10.1 `lib/upload.js` 독립 모듈 (saveUpload, buildMediaPrompt, downloadTelegramFile)
- [x] 10.2 server.js에서 import + UPLOADS_DIR 바인딩
- [x] 10.3 `bot.on('message:photo')` 핸들러
- [x] 10.4 `bot.on('message:document')` 핸들러
- [x] 10.5 `tgOrchestrate()` 공통 함수 추출 (text handler 리팩토링)
- [x] 10.6 `POST /api/upload` 엔드포인트 (express.raw, 20MB limit)
- [x] 10.7 Web UI 📎 버튼 + `<input type="file">`
- [x] 10.8 Web UI 드래그 & 드랍 (dragenter/dragleave/drop 오버레이)
- [x] 10.9 Web UI 파일 프리뷰 바 + clearAttachedFile
- [x] 10.10 CLI `/file <path> [caption]` 명령 (simple + default 모드)

## 설계

- `ctx.getFile()` → Telegram 서버에서 file_path 획득
- `https.get({family:4})` 로 이미지 바이너리 다운로드
- `~/.cli-claw/uploads/{timestamp}_{sanitized}.{ext}` 에 저장
- 프롬프트: `[사용자가 파일을 보냈습니다: {path}]\n이 파일을 Read 도구로 읽고 분석해주세요.`
- CLI Agent가 Read 도구로 파일 자동 분석

## 레퍼런스

- `openclaw-ref/src/telegram/bot.media.*.test.ts` — 미디어 E2E 테스트
- Telegram Bot API: `getFile` → `https://api.telegram.org/file/bot<token>/<file_path>`
