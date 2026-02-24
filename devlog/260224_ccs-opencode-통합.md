# 2026-02-24: CCS + OpenCode 통합

## 작업 내용
- CCS v7.49.1 설치 + OAuth(agy) 인증
- `ccs-wrapper` 클론 (bitkyc08-arch/ccs-wrapper)
- Thinking Wrapper SSE 스트리밍 버그 수정 (`aiter_lines → aiter_bytes`)
- Wrapper backend: CLIProxyAPI(:6001) → CCS(:8319)로 전환
- CLIProxyAPI v6.8.17 → v6.8.26 업데이트
- OpenCode config: Anthropic/OpenAI provider를 Wrapper(:8318) 경유로 등록
- LaunchAgent 영구 등록: CCS(:8319), Wrapper(:8318)
- cli-claw `commands.js`/`config.js` OpenCode 모델 목록 CCS Wrapper 모델로 교체
- cli-claw `settings.json` opencode 기본 모델 → `anthropic/claude-opus-4-6-thinking`

## 포트 맵
| 포트 | 서비스 | 비고 |
|------|--------|------|
| 6001/6002 | anti-api (node) | 기존 유지 |
| 8317 | CLIProxyAPI | 기존 유지 (RisuAI) |
| 8318 | Thinking Wrapper | 신규 (launchd) |
| 8319 | CCS CLIProxy Plus | 신규 (launchd) |

## 이슈
- CLIProxyAPI v6.8.26 스트리밍 불완전 → CCS로 우회
