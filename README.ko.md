<div align="center">

# 🦞 CLI-CLAW

### 통합 AI 에이전트 오케스트레이션 플랫폼

*인터페이스 하나. CLI 다섯 개. 차단? 그런 건 없다.*

[![Tests](https://img.shields.io/badge/tests-216%20pass-brightgreen)](#-테스트)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-ISC-yellow)](LICENSE)

[English](README.md) / **한국어** / [中文](README.zh-CN.md)

<!-- 📸 TODO: Web UI 스크린샷 -->
<!-- ![CLI-CLAW Web UI](docs/screenshots/web-ui.png) -->

</div>

---

## 왜 CLI-CLAW인가?

대부분의 AI 코딩 도구는 결국 같은 벽에 부딪힙니다: **API 키 차단, 레이트 리밋, 이용약관 위반.**

CLI-CLAW는 접근 방식 자체가 다릅니다 — 모든 요청이 벤더가 직접 배포하는 **공식 CLI 바이너리**를 그대로 거칩니다. 래퍼가 아닙니다. 프록시도 아닙니다. 계정 안전합니다.

<!-- 📸 TODO: 터미널 TUI 스크린샷 -->
<!-- ![Terminal TUI](docs/screenshots/terminal-tui.png) -->

---

## 이런 걸 합니다

- 🔄 **5개 CLI, 1개 화면** — Claude · Codex · Gemini · OpenCode · Copilot. `/cli`로 전환.
- ⚡ **자동 폴백** — `claude → codex → gemini`. 하나 죽으면 다음 놈이 받아칩니다.
- 🎭 **멀티 에이전트 오케스트레이션** — 복잡한 작업을 역할 기반 서브에이전트들이 5단계 파이프라인으로 처리.
- 🔌 **MCP 동기화** — MCP 서버 한 번 설치하면 5개 CLI 전부에서 즉시 사용 가능.
- 📦 **100+ 스킬** — 내장 플러그인 시스템. Active 스킬은 프롬프트에 자동 주입, Reference 스킬은 필요 시.
- 🧠 **영속 메모리** — 대화 자동 요약, 장기 기억, 프롬프트 주입.
- 📱 **텔레그램 봇** — 폰에서 에이전트를 제어.
- 🌐 **브라우저 자동화** — Chrome CDP + AI 기반 Vision Click.
- 🌍 **다국어** — 한국어 / English, 어디서나 (UI, API, CLI, Telegram).

<!-- 📸 TODO: 오케스트레이션 스크린샷 -->
<!-- ![Orchestration](docs/screenshots/orchestration.png) -->

---

## 빠른 시작

```bash
# 설치 (5개 CLI, MCP, 100+ 스킬 전부 자동 설정)
npm install -g cli-claw

# 쓰고 싶은 CLI만 인증 (하나만 있어도 됩니다)
claude auth          # Anthropic
codex login          # OpenAI
gemini               # Google (최초 실행)

# 시작
cli-claw doctor      # 뭐가 설치됐는지 확인
cli-claw serve       # Web UI → http://localhost:3457
cli-claw chat        # 또는 터미널 TUI
```

<!-- 📸 TODO: 텔레그램 봇 스크린샷 -->
<!-- ![Telegram Bot](docs/screenshots/telegram-bot.png) -->

---

## CLI 명령어

```bash
cli-claw serve                         # 서버 시작
cli-claw chat                          # 터미널 TUI
cli-claw doctor                        # 진단 (12개 체크)
cli-claw skill install <name>          # 스킬 설치
cli-claw mcp install <package>         # MCP 설치 → 5개 CLI 전부 동기화
cli-claw memory search <query>         # 메모리 검색
cli-claw browser start                 # Chrome 시작 (CDP)
cli-claw browser vision-click "로그인"  # AI가 알아서 클릭
cli-claw reset                         # 전체 초기화
```

---

## 모델

각 CLI에 프리셋이 준비되어 있지만, **아무 모델 ID나** 직접 타이핑해도 됩니다.

<details>
<summary>전체 프리셋 보기</summary>

| CLI | 기본값 | 주요 모델 |
|-----|--------|-----------|
| **Claude** | `claude-sonnet-4-6` | opus-4-6, haiku-4-5, 확장 사고 변형 |
| **Codex** | `gpt-5.3-codex` | spark, 5.2, 5.1-max, 5.1-mini |
| **Gemini** | `gemini-2.5-pro` | 3.0-pro-preview, 3-flash-preview, 2.5-flash |
| **OpenCode** | `claude-opus-4-6-thinking` | 🆓 big-pickle, GLM-5, MiniMax, Kimi, GPT-5-Nano |
| **Copilot** | `gpt-4.1` 🆓 | 🆓 gpt-5-mini, claude-sonnet-4.6, opus-4.6 |

</details>

> 🔧 프리셋에 모델을 추가하려면: `src/cli-registry.js` 하나만 수정 — 전체 자동 반영.

---

## 테스트

```bash
npm test    # 216개 테스트, ~260ms, 외부 의존성 0
```

---

## 문서

| 문서 | 내용 |
|------|------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 설계, 모듈 의존성, 아키텍처 패턴, 파일 구조 |
| [TESTS.md](TESTS.md) | 전체 테스트 목록, 커버리지 상세, Phase 20 테스트 계획 |
| [REST API](docs/ARCHITECTURE.md#rest-api) | 40+ 엔드포인트 레퍼런스 |

함수 레벨 레퍼런스는 [`devlog/str_func.md`](devlog/str_func.md) 참조.

---

## 라이선스

ISC
