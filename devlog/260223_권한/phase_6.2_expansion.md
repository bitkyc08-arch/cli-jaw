# Phase 6.2 — 스킬 확장 + Codex 선별

> 상태: 📋 계획

## 1. "불가" 재평가 — 설치 안내로 살릴 수 있는 스킬

기존 🚫 목록을 재검토. SKILL.md에 의존성 설치 안내 넣으면 대부분 사용 가능.

### ✅ 추가 가능 (의존성만 설치하면 OK)

| 스킬            | 설명                     | 설치 안내                        | 판정   |
| --------------- | ------------------------ | -------------------------------- | ------ |
| imsg            | iMessage CLI 발신/검색   | `brew install imsg` (macOS 전용) | ✅ 추가 |
| wacli           | WhatsApp CLI 발신/검색   | `go install wacli`               | ✅ 추가 |
| bear-notes      | Bear 메모 앱 CLI         | `brew install grizzly` (macOS)   | ✅ 추가 |
| sonoscli        | Sonos 스피커 제어        | `brew install sonos`             | ✅ 추가 |
| eightctl        | Eight Sleep 제어         | `go install eightctl`            | ✅ 추가 |
| sag             | ElevenLabs TTS           | `brew install sag` + API키       | ✅ 추가 |
| sherpa-onnx-tts | 로컬 TTS (오프라인)      | `pip install sherpa-onnx`        | ✅ 추가 |
| blogwatcher     | RSS/블로그 모니터링      | `go install blogwatcher`         | ✅ 추가 |
| peekaboo        | macOS UI 자동화          | `brew install peekaboo` (macOS)  | ✅ 추가 |
| oracle          | 프롬프트+파일 번들링 CLI | `brew install oracle`            | ✅ 추가 |
| gifgrep         | GIF 검색/다운로드        | `brew install gifgrep`           | ✅ 추가 |
| gemini          | Gemini CLI 원샷 호출     | `npm i -g @anthropic/gemini`     | ✅ 추가 |
| openai-whisper  | 로컬 Whisper STT         | `pip install openai-whisper`     | ✅ 추가 |
| mcporter        | MCP 서버 직접 호출       | `npm i -g mcporter`              | ✅ 추가 |
| session-logs    | 세션 로그 검색           | `brew install jq rg`             | ✅ 추가 |
| healthcheck     | 서버 보안 점검           | 의존성 없음 (쉘 스크립트)        | ✅ 추가 |
| coding-agent    | 코딩 태스크 위임         | codex/claude 설치 필요           | ✅ 추가 |
| model-usage     | 모델별 사용량 조회       | `npm i -g codexbar`              | ✅ 추가 |
| camsnap         | 카메라 프레임 캡처       | `brew install camsnap`           | ✅ 추가 |

### ⚠️ 구조 변경 필요 (OpenClaw 종속)

| 스킬                | 설명              | 문제                                                      | 판정               |
| ------------------- | ----------------- | --------------------------------------------------------- | ------------------ |
| discord             | Discord 채널 연동 | OpenClaw `message` 도구 종속 → CLI-Claw용으로 재작성 필요 | ⚠️ 재작성           |
| slack               | Slack 채널 연동   | OpenClaw `message` 도구 종속 → CLI-Claw용으로 재작성 필요 | ⚠️ 재작성           |
| canvas              | HTML 캔버스 표시  | OpenClaw 노드 UI 종속                                     | ❌ 불가             |
| clawhub             | 스킬 마켓 CLI     | clawhub.com 종속                                          | ❌ 불가 (자체 구현) |
| voice-call          | 음성통화 플러그인 | OpenClaw 음성 인프라 종속                                 | ❌ 불가             |
| food-order/ordercli | Foodora 주문      | 유럽 전용 서비스                                          | ❌ 지역 제한        |

### 결론

- **기존 "불가" 25개 중 19개 → ref에 추가 가능** (설치 안내만 SKILL.md에 포함)
- **3개 재작성 필요** (discord, slack → CLI-Claw 채널 모듈로)
- **4개만 진짜 불가** (canvas, clawhub, voice-call, food-order)

---

## 2. Codex 기본 27개 — 필수/선택 분류

`copyDefaultSkills()`가 전부 active로 복사 중 → 핵심만 active, 나머지는 ref로.

### ⚡ 필수 (active 유지) — 범용, 자주 사용

| 스킬                | 이유                     |
| ------------------- | ------------------------ |
| screenshot          | 화면 캡처, 디버깅 필수   |
| playwright          | 브라우저 자동화, 테스트  |
| yeet                | git push+PR 원샷, 생산성 |
| doc                 | .docx 읽기/쓰기          |
| pdf                 | PDF 읽기/생성            |
| spreadsheet         | 엑셀/CSV 편집            |
| gh-address-comments | PR 리뷰 처리, 자주 씀    |
| gh-fix-ci           | CI 실패 자동 수정        |
| openai-docs         | OpenAI 문서 참조         |
| imagegen            | 이미지 생성/편집         |

### 📦 선택 (ref로 이동 가능) — 특정 서비스 의존

| 스킬                          | 이유                          |
| ----------------------------- | ----------------------------- |
| atlas                         | ChatGPT Atlas 앱 전용 (macOS) |
| cloudflare-deploy             | Cloudflare 쓸 때만            |
| develop-web-game              | 웹 게임 개발 특화             |
| figma-implement-design        | Figma MCP 필요                |
| jupyter-notebook              | Jupyter 쓸 때만               |
| linear                        | Linear 쓸 때만                |
| netlify-deploy                | Netlify 쓸 때만               |
| notion-knowledge-capture      | Notion + API키 필요           |
| notion-meeting-intelligence   | Notion 특화                   |
| notion-research-documentation | Notion 특화                   |
| notion-spec-to-implementation | Notion 특화                   |
| render-deploy                 | Render 쓸 때만                |
| sentry                        | Sentry 쓸 때만                |
| sora                          | Sora 비디오 (특화)            |
| speech                        | TTS (상황 의존)               |
| transcribe                    | STT (상황 의존)               |
| vercel-deploy                 | Vercel 쓸 때만                |

### ✅ 구현 완료 — `lib/mcp-sync.js` `copyDefaultSkills()`

npm install / 서버 시작 시 자동 분류:

```
[skills] Codex: 10 active, 17 ref, 0 skipped
[skills] OpenClaw: 22 skills → ref
[skills] auto-activated: browser, notion
```

2×3 매트릭스:

|              | ⚡ Active                                                                                                        | 📦 Ref                                                                                                                                                                                        | ❌ Delete                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Codex**    | screenshot, playwright, yeet, doc, pdf, spreadsheet, gh-address-comments, gh-fix-ci, openai-docs, imagegen (10) | atlas, cloudflare-deploy, develop-web-game, figma-implement-design, jupyter-notebook, linear, netlify-deploy, notion-×4, render-deploy, sentry, sora, speech, transcribe, vercel-deploy (17) | —                                           |
| **OpenClaw** | browser, notion (2)                                                                                             | weather, himalaya, github 등 (22)                                                                                                                                                            | canvas, clawhub, voice-call, food-order (4) |
