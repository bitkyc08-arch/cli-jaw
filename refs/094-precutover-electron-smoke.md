# 094 pre-cutover Electron 실기 스모크 (2026-07-23, 114 WP4)

- 환경: macOS 실기, `npm --prefix electron run build` 후 `npm --prefix electron run start -- --manager-url=http://127.0.0.1:24577/dashboard2/ --spawn --remote-debugging-port=9223`
- RC: WP3 종료 시점 HEAD 계열 (최종 RC는 WP5 closeout 소유)

| 체크 | 결과 |
|---|---|
| cold launch → `/dashboard2/` 로드 | PASS (title=Jaw, url=127.0.0.1:24577/dashboard2/) |
| `window.cliJawDesktop.identify` 존재 | PASS |
| d2 셸/사이드바 렌더 | PASS (인스턴스 목록 + jaw/jwc 모드 스위처) |
| 인스턴스 선택 → 채팅 히스토리 렌더 | PASS (jwc:3457 — 히스토리/tool 세그먼트/컴포저) |
| Terminal 패널 — 실제 PTY | PASS (zsh 세션, 실출력, multisession 탭 UI) |
| Settings 모달 (link previews/theme/shortcuts/locale) | PASS |
| ChatView identity (settings 열림 중 유지) | PASS |
| console 크래시/백지 | 없음 |

- 스크린샷: `devlog/_plan/260711_manager_redesign_feature_migration/evidence_114_electron_chat.png`, `evidence_114_electron_terminal_settings.png`
- 잔여: Notes 탭 overflow picker 경유 진입은 CDP 스크립트에서 미클릭(수동 UI로는 노출 확인) — e2e 웹 스위트가 커버. default-URL 컷오버 패키지/3-OS는 WP5.
