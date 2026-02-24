# 260224_cmd — Phase별 테스트 체크리스트

> 서버 재시작 후 테스트: `node bin/cli-claw serve`

---

## Phase 0: 텔레그램 환경변수 전환

- [ ] `settings.json`에 `telegramToken`, `telegramAllowlist` 필드 존재
- [ ] `.env`에서 `TELEGRAM_*` 제거 후에도 Telegram 봇 정상 동작
- [ ] `TG_EXCLUDED_CMDS`로 특정 커맨드 Telegram에서 숨김 확인

---

## Phase 1: CLI Autocomplete

- [ ] `cli-claw chat`에서 `/` 입력 → popup에 전체 커맨드 목록 표시
- [ ] `/he` → `/help`만 필터링
- [ ] ↑/↓ 선택 → 하이라이트 이동
- [ ] Tab → 선택 항목 입력창에 채움 (실행 안 함)
- [ ] Enter (인자 없는 커맨드) → 즉시 실행
- [ ] ESC → 드롭다운 닫힘, 입력 보존
- [ ] popup이 프롬프트 **아래**에 표시 (Phase 1.3c)
- [ ] 긴 목록 windowing: 6줄 제한, 스크롤 동작

---

## Phase 2: Server API + Telegram

### API

- [ ] `GET /api/commands?interface=web` → 커맨드 목록 JSON
- [ ] `POST /api/command {"text":"/help"}` → 카테고리별 목록 반환
- [ ] `POST /api/command {"text":"/status"}` → 서버 상태 (`ok: true`)
- [ ] `POST /api/command {"text":"/foobar"}` → `code: unknown_command`
- [ ] `POST /api/command {"text":"/model"}` → 현재 모델 표시
- [ ] `POST /api/command {"text":"/model gemini-2.5-pro"}` → 모델 변경 성공

### Telegram

- [ ] `/help` → 커맨드 목록 응답
- [ ] `/status` → 서버 상태 응답
- [ ] `/model` → 현재 모델 응답
- [ ] 일반 텍스트 → agent 정상 응답
- [ ] `/mcp` → "Telegram에서 사용할 수 없습니다" 안내
- [ ] 입력창 `/` 버튼 → Telegram 커맨드 제안 UI 표시 (`setMyCommands`)

---

## Phase 3: Web UI Dropdown

- [ ] 입력창에 `/` → 드롭다운 표시
- [ ] `/hel` → `/help` 필터링
- [ ] ↓/↑ 키보드 이동 + Enter 선택
- [ ] 마우스 클릭으로 선택
- [ ] 드롭다운 외부 클릭 → 닫힘
- [ ] `/clear` → 채팅 영역 비움 (DB 유지)
- [ ] 한글 입력 (`/ㅁ` → `/모` → `/모델`) → compositionend 정상 처리
- [ ] `color-mix` 기반 선택 하이라이트 색상
- [ ] `scroll-margin-block` 스크롤 여백
- [ ] 300ms 이내 자동 닫힘 타이머

---

## Phase 4: Argument Autocomplete (CLI)

- [ ] `/model ` (공백 후) → **argument stage** 진입, 모델 목록 표시
- [ ] 모델 옆에 **CLI 라벨** 표시 (claude/codex/gemini/opencode/custom)
- [ ] Context header 표시: `model ▸ 인자 선택`
- [ ] `/model g` → `g`로 시작하는 모델 점수순 필터링
- [ ] `/cli ` → CLI 목록 (claude, codex, gemini, opencode)
- [ ] `/skill ` → `list`, `reset`
- [ ] `/browser ` → `status`, `tabs`
- [ ] PageUp/PageDown → visibleRows 단위 이동
- [ ] Home/End → 첫/끝 이동
- [ ] argument stage에서 Tab → `insertText` 채움 (실행 안 함)
- [ ] argument stage에서 Enter → `insertText` 채움 (실행 안 함)
- [ ] argument popup 8줄 (command는 6줄)

---

## Phase 5: Stabilization

### B 항목 (에러 핸들링)

- [ ] `DEBUG=1 cli-claw chat` → `safeCall`/`argComplete` 에러 로그 출력 확인 (B2, B4)
- [ ] 터미널 창 크기 빠르게 변경 → 깜빡임 없이 깔끔 재렌더 (B5 resize debounce)
- [ ] Web에서 서버 중단 후 `/status` → 10초 타임아웃 후 에러 메시지 (B3)

### A 항목 (UX)

- [ ] Web `/status` → 시스템 메시지 **파란색 테두리** (`msg-type-info`)
- [ ] Web `/foobar` → 시스템 메시지 **빨간색 테두리** (`msg-type-error`)
- [ ] Web `/model xxx` → 성공 시 **초록색 테두리** (`msg-type-success`)
- [ ] 브라우저 콘솔에서 `[slash-commands] loadCommands failed:` 로그 확인 — 서버 끈 상태에서 새로고침 시 (A2)

### C 항목 (회귀)

- [ ] `/clear` → 메시지 수 변동 없음 (비파괴)
- [ ] `/reset confirm` → 메시지 전부 삭제 (파괴적)
- [ ] 일반 텍스트 입력 → agent에 정상 전달 (슬래시 아닌 메시지)

---

## Phase 6: Prompt Injection (📋 계획 — 구현 전)

> 아직 미구현. 구현 후 체크 항목 추가 예정.

- [ ] CLI별 프롬프트 삽입 정규화 확인
- [ ] 히스토리 통합 확인
- [ ] 시스템 프롬프트 중복 제거 확인

---

## 참고

| 환경 변수          | 용도                                                   |
| ------------------ | ------------------------------------------------------ |
| `DEBUG=1`          | safeCall, argComplete 에러 로그 활성화                 |
| `TG_EXCLUDED_CMDS` | Telegram `setMyCommands`에서 제외할 커맨드 (쉼표 구분) |
