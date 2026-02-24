# Phase 5: 테스트 + 마무리

> 예상 시간: 30분

---

## 5.1 세션 관리

### DB 세션 저장
기존 session 테이블의 `session_id` 컬럼 그대로 활용:

```js
// agent.js — ACP 세션 생성 후
const session = await acp.createSession(settings.workingDir);
// session.id를 기존 db 세션 테이블에 저장
// 기존 패턴: updateSession(agentLabel, session.id)
```

### Resume 플로우
```js
// /continue 시
if (cli === 'copilot' && lastSession?.session_id) {
    const acp = new AcpClient({ model, workDir: settings.workingDir, permissions });
    await acp.initialize();
    await acp.loadSession(lastSession.session_id); // session/load (공식 ACP 메서드)
    await acp.prompt(newPrompt);
}
```

> **`session/load`는 선택적 capability** — Phase 2에서 copilot이 지원하는지 확인
> 미지원 시 CLI `--resume` 플래그로 fallback

---

## 5.2 통합 테스트 체크리스트

### 기본 동작
- [ ] `/cli copilot` → CLI 전환 성공
- [ ] `/model gpt-4.1` → 모델 변경
- [ ] "hello" → 응답 수신
- [ ] "list files" → tool use 이벤트 + 결과

### 스트리밍
- [ ] WebSocket으로 agent_tool (🔧/💭) 이벤트 수신
- [ ] agent_output 텍스트 스트리밍 (ws.js 경유)
- [ ] agent_done 완료

### 세션
- [ ] `/continue` → 이전 세션 이어하기
- [ ] 세션 ID가 db에 저장
- [ ] 새 대화 시작 → 새 세션 생성

### 텔레그램
- [ ] 텔레그램에서 copilot 응답 수신
- [ ] 중간 이벤트 포워딩 (📡)
- [ ] ⚠️ `/cli copilot` 전환: 텔레그램에서는 fallbackOrder만 변경 가능 (서버 settings에서 직접 변경 필요)

### UI
- [ ] 웹 설정에서 Copilot 선택 가능
- [ ] 모델 드롭다운 표시
- [ ] 직원 UI에서 Copilot 선택 가능
- [ ] `/version` → copilot 버전 표시

### MCP
- [ ] `/mcp sync` → `~/.copilot/mcp-config.json` 동기화
- [ ] MCP 서버 목록이 copilot에 반영

### 에러 처리
- [ ] copilot 미설치 시 → 에러 메시지
- [ ] 인증 실패 시 → 에러 메시지
- [ ] 프로세스 크래시 → agent_done(error) + 정리

---

## 5.3 모델별 테스트

| 모델 | 비용 | 테스트 |
|------|------|--------|
| `gpt-4.1` | 0x 무료 | ✅ 기본 테스트용 |
| `gpt-5-mini` | 0x 무료 | ✅ 보조 테스트 |
| `claude-sonnet-4.6` | 1x | ⚠️ 한도 확인 후 |
| `gpt-5.3-codex` | 1x | ⚠️ 한도 확인 후 |

---

## 5.4 커밋 전략

```bash
# Phase 1 완료 후 (변경된 파일만 스테이징)
git add src/config.js src/commands.js bin/postinstall.js public/ lib/mcp-sync.js
git commit -m "[copilot] phase 1: CLI 감지 + 설정 + UI"

# Phase 2 완료 후
git add src/acp-client.js
git commit -m "[copilot] phase 2: ACP 클라이언트 모듈"

# Phase 3 완료 후
git add src/agent.js
git commit -m "[copilot] phase 3: agent.js ACP 통합"

# Phase 4 완료 후
git add src/events.js
git commit -m "[copilot] phase 4: events.js ACP 파싱"

# Phase 5 완료 후 (최종 테스트 통과)
git add -A && git commit -m "[copilot] phase 5: 테스트 완료 + 마무리"
```

---

## 5.5 알려진 리스크

1. **`session/load` 지원 미확인**: Phase 2에서 copilot이 `loadSession` capability 알리는지 확인 → 미지원 시 CLI `--resume` fallback
2. **MCP config 포맷**: `~/.copilot/mcp-config.json` 포맷이 Claude `.mcp.json`과 동일한지 확인 필요
3. **Copilot 자동 업데이트**: 바이너리 경로 동일하므로 심링크 유지됨
