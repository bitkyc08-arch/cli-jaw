# MVP-7: Integration Test

Telegram + Web UI + CLI spawn 동시 작동 검증.

## 테스트 시나리오

### 1. 기본 동작
- [ ] `node server.js` → Web UI 접속 → 메시지 전송 → 응답 수신
- [ ] 같은 세션에서 두 번째 메시지 → resume 작동 확인

### 2. 모델 전환
- [ ] claude로 대화 → codex로 전환 → 최근 5개 메시지 + memory 전달 확인
- [ ] 전환 후 resume 체인 정상 작동

### 3. 프롬프트 주입
- [ ] A-2 수정 → B.md 재생성 확인
- [ ] claude: `--append-system-prompt` 로그 확인
- [ ] codex: `codex.md` symlink → B.md 확인

### 4. Telegram 동시 접속
- [ ] Telegram에서 메시지 → Web UI에도 표시
- [ ] Web UI에서 메시지 → 응답이 Telegram에도 도달
- [ ] 동시에 보내도 충돌 없음

### 5. Employee 호출
- [ ] Employee 설정 추가 → Main Agent가 subtask JSON 출력 → sub-agent 분배
- [ ] Employee 없으면 → 일반 단일 에이전트 모드

### 6. /clear
- [ ] `/clear` → 메시지 전체 삭제 + session_id 리셋
- [ ] memory 보존 확인
- [ ] Telegram + Web UI 모두 깨끗해짐

### 7. Permission
- [ ] Auto → `--dangerously-skip-permissions` 로그 확인
- [ ] Safe → 해당 플래그 없음 확인
