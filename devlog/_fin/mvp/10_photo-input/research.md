# Phase 10 리서치: 이미지/파일 인풋 방식 비교

## CLI별 이미지 입력 방식

| CLI         | 방식                                  | 비고                                                |
| ----------- | ------------------------------------- | --------------------------------------------------- |
| Claude Code | `Read` 도구로 파일 경로 접근          | `--dangerously-skip-permissions` 필요 시            |
| Codex       | `--image ./file.png` 또는 `-i` 플래그 | PNG, JPEG, GIF, WebP 지원. BMP/TIFF/SVG/HEIC 미지원 |
| Gemini CLI  | 직접 지원 없음                        | 파일 경로를 프롬프트에 텍스트로 전달                |
| OpenCode    | 직접 지원 없음                        | 파일 경로 방식                                      |

## 방식 비교

### 방안 1: CLI별 네이티브 이미지 인자 사용
```
Claude: 프롬프트에 경로 → Read 도구
Codex:  --image ./file.png
Gemini: 미지원
```
- ❌ CLI마다 분기 로직 필요
- ❌ Gemini/OpenCode 미지원
- ❌ spawnAgent 인자 빌더 복잡화

### 방안 2: JSON stdin으로 base64 전송
```json
{"type":"image","data":"base64...","mime":"image/png"}
```
- ❌ NDJSON 파싱에 대용량 바이너리 부적합
- ❌ CLI들이 이 프로토콜 미지원
- ❌ stdin 버퍼 크기 제한

### 방안 3: 파일 저장 + 경로 주입 ✅ (채택)
```
파일 → ~/.cli-claw/uploads/ 저장
프롬프트 → "[사용자가 파일을 보냈습니다: /abs/path]"
에이전트 → Read 도구로 파일 접근
```
- ✅ 모든 CLI에서 동일하게 동작
- ✅ 추가 의존성 0
- ✅ 파일 크기 제한 없음 (디스크 공간만큼)
- ✅ spawnAgent 수정 불필요
- ⚠️ 디스크 정리 필요 (향후 cron/retention)

## 채택 근거

> 이전 대화 (dd1ade72)에서 "json으로는 안되니까 유저가 텍스트 외의 것을 입력하면 폴더에 저장하고 그 경로를 알려주기로 했다"고 결정.

## Telegram 파일 다운로드 플로우

```
1. ctx.message.photo → file_id 추출 (배열 마지막 = 최고 해상도)
2. GET https://api.telegram.org/bot{token}/getFile?file_id={id}
   → { result: { file_path: "photos/file_123.jpg" } }
3. GET https://api.telegram.org/file/bot{token}/{file_path}
   → 바이너리 다운로드
4. saveUpload(buffer, originalName) → /abs/path
```

**주의: IPv4 강제 필수**
Node 22의 fetch는 기본 IPv6 우선이라 Telegram API에서 ETIMEDOUT 발생.
기존 `ipv4Agent` 패턴과 동일하게 `https.Agent({ family: 4 })` 사용.

## 향후 고려사항

- [ ] 업로드 디렉토리 자동 정리 (30일 이상 파일 삭제)
- [ ] 이미지 리사이즈 (대용량 → 썸네일로 에이전트 응답 속도 개선)
- [ ] 다중 파일 첨부 지원 (현재 1개씩)
- [ ] 클립보드 붙여넣기 (Ctrl+V → 이미지 캡처)
