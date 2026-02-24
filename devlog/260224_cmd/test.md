# 260224_cmd — 테스트 체크리스트

> Phase 1–5 전체 검증

---

## 🤖 에이전트 확인 완료 (curl)

- [x] C1: `POST /api/command {"text":"/help"}` → 카테고리별 커맨드 목록 반환
- [x] C2: `POST /api/command {"text":"/model"}` → 현재 모델 출력 (`codex: gpt-5.3-codex`)
- [x] C4: `/clear` → 메시지 수 변동 없음 (343→343, 비파괴)
- [x] C5: `/foobar` → `ok: false`, `code: unknown_command`
- [x] C6: API 응답에 `type` 필드 포함 확인 (코드 검증 — 서버 재시작 후 반영)

---

## 👤 유저 수동 체크 (서버 재시작 후)

### CLI (`cli-claw chat`)

- [ ] `/` 입력 → 커맨드 힌트 popup 표시
- [ ] `/model g` → 모델 목록 + **CLI 라벨** (claude/codex/gemini/opencode) 표시
- [ ] PageDown → 긴 목록에서 paging 동작
- [ ] Tab → 선택 항목 입력창에 채움 (실행 안 함)
- [ ] Enter (인자 없는 커맨드) → 즉시 실행
- [ ] ESC → 드롭다운 닫힘, 입력 보존
- [ ] 일반 텍스트 입력 → agent에 정상 전달
- [ ] 터미널 창 크기 변경 → 깜빡임 없이 깔끔하게 재렌더 (resize debounce)

### Web UI (`http://localhost:3457`)

- [ ] 입력창에 `/` → 드롭다운 표시
- [ ] `/hel` → `/help` 필터링
- [ ] ↓/↑ 키보드 이동 + Enter 선택
- [ ] 마우스 클릭으로 선택
- [ ] 드롭다운 외부 클릭 → 닫힘
- [ ] `/status` → 시스템 메시지 **파란색 테두리** (type: info)
- [ ] `/foobar` → 시스템 메시지 **빨간색 테두리** (type: error)
- [ ] `/clear` → 채팅 영역 비움 (메시지 DB는 유지)
- [ ] 한글 입력 (`/ㅁ` → `/모` → `/모델`) → 오류 없이 동작

### Telegram

- [ ] `/help` → 커맨드 목록 응답
- [ ] `/status` → 서버 상태 응답
- [ ] `/model` → 현재 모델 응답
- [ ] `안녕하세요` (일반 텍스트) → agent 정상 응답
- [ ] `/mcp` → "Telegram에서 사용할 수 없습니다" 안내

---

## 📝 참고

- `type` 색상은 서버 재시작 후 반영됨 (CSS: `.msg-type-success` 초록, `.msg-type-error` 빨강, `.msg-type-info` 파랑)
- `DEBUG=1 cli-claw chat`으로 실행하면 `safeCall`, `argComplete` 에러 로그 확인 가능
