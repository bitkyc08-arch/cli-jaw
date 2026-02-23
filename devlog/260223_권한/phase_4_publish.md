# Phase 4 — GitHub 퍼블리시 준비

## 배경: OpenClaw 밴 사태

OpenClaw은 Claude Pro/Max **OAuth 토큰을 제3자 서버에서 사용**하는 구조 → Anthropic ToS 위반으로 대량 계정 정지 발생 (2026.02~).
Google AI Ultra (Gemini) 쪽도 동일 이슈. OpenClaw 깃허브 자체도 일시 정지됨.

**CLI-Claw은 CLI spawn 래핑** 방식이라 이 문제가 구조적으로 없음:
- OAuth 토큰 추출 ❌ → 공식 CLI 프로세스를 그대로 spawn
- 트래픽 패턴 = 사용자 본인 터미널과 동일
- **밴 리스크 제로** = 핵심 차별점

---

## 4.1 시크릿 정리 ✅

- [x] `settings.json` → `.gitignore` (이미 추가됨, git 미추적 확인)
- [ ] Telegram 봇 토큰 재발급 (@BotFather) ← 퍼블리시 직전에
- [x] `.env` 지원 + `.env.example` 작성 (`TELEGRAM_TOKEN`, `PORT`)
- [x] `server.js`에서 환경변수 로드 (의존성 0개 `.env` 로더)
- [x] `LICENSE` (MIT) 추가

## 4.2 코드 구조 정리

→ **Phase 5로 분리** (별도 문서: `phase_5_modularize.md`)

## 4.3 퍼블리시 준비

- [x] `LICENSE` (MIT)
- [ ] `CONTRIBUTING.md` — PR 규칙, 개발 환경 세팅, 코드 스타일
- [ ] 영문 README 핵심 섹션 추가 (한글 유지하되 상단에 영문 요약)
- [ ] "Why CLI-Claw?" 섹션: CLI spawn vs OAuth → 밴 리스크 비교
- [ ] `Dockerfile` + `docker-compose.yml` — 원클릭 실행
- [ ] GitHub Actions CI — lint + test

## 4.4 기여자 유입

- [ ] `good first issue` 라벨 10개+ 생성
- [ ] Reddit 포스팅: r/ClaudeAI, r/LocalLLaMA
- [ ] Discord 서버 개설

## 포지셔닝

> **"CLI-Claw wraps official CLI tools instead of stealing OAuth tokens. Your subscription, your terminal, zero ban risk."**
