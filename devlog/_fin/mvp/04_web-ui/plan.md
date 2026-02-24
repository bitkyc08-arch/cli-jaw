# MVP-4: Web UI

단일 세션 Web UI. claw-lite UI를 기반으로 단순화.

## 체크리스트

- [ ] `public/index.html` — 3컬럼 레이아웃
  - 좌측: Memory 뷰어 (mock — DB에서 읽기만) + Stats
  - 중앙: 단일 세션 채팅 (메시지 스트림, 마크다운 렌더링)
  - 우측: Agent Config (CLI/Model/Effort/Permissions/A-2 편집)
- [ ] `public/style.css` — claw-lite 스타일 기반
- [ ] WebSocket 연결 (agent_status, agent_output, agent_done)
- [ ] 메시지 전송 → `POST /api/message` → spawn → 스트리밍
- [ ] `/clear` 버튼 + 입력창에서 `/clear` 명령
- [ ] 모델 전환 UI (CLI 드롭다운 변경 → session 리셋)
- [ ] Permission 토글 (Safe/Auto)
- [ ] 새로고침 시 기존 메시지 로드 (`GET /api/messages`)

## claw-lite에서 가져올 것

- HTML/CSS 기본구조 (3컬럼)
- WebSocket 클라이언트 로직
- 메시지 렌더링 (마크다운, 코드블록)
- Settings 패널 기본 UI
- Agents 탭 → Agent Config 단일 패널로 단순화
