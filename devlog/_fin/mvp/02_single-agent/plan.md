# MVP-2: Single Agent Spawn

단일 에이전트 CLI spawn + NDJSON 파싱 + 세션 resume.

## 체크리스트

- [ ] `buildArgs(cli, model, effort, permissions)` — CLI별 인자 생성
  - `permissions: auto` → `--dangerously-skip-permissions` / `--full-auto` / `-y`
  - `permissions: safe` → 위 플래그 생략
- [ ] `spawnAgent(cli, prompt, cwd)` — 단일 에이전트 spawn
  - session 테이블에서 `session_id` 확인 → resume or 새 세션
  - stdin에 순수 사용자 메시지만 전달
- [ ] NDJSON 파싱 (`extractFromEvent`, `extractSessionId`)
  - claw-lite에서 그대로 가져옴
- [ ] 세션 resume 로직:
  - claude: `--resume SESSION_ID`
  - codex: `resume THREAD_ID`
  - gemini: 새 세션 (resume 미지원)
- [ ] 응답 → messages 테이블 INSERT
- [ ] session 테이블 session_id 갱신
- [ ] WebSocket broadcast (`agent_status`, `agent_output`, `agent_done`)
- [ ] 모델 전환 시: session_id NULL → 최근 5개 메시지 + memory 로드

## claw-lite에서 가져올 것

- `spawnAgent()` 핵심 로직
- `buildArgs()` — permissions 분기 추가
- NDJSON 파서 (`extractFromEvent`, `extractSessionId`)
- `makeCleanEnv()`
