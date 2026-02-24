# Phase 7: Copilot ACP 실시간 스트리밍

> 문제: Copilot 응답이 스트리밍 없이 전체 텍스트가 한번에 출력됨

---

## 현상

- 다른 CLI (Claude, Codex, Gemini): NDJSON stdout → `agent_chunk` broadcast → 실시간 표시
- **Copilot ACP**: `session/update` → `agent_message_chunk` → `ctx.fullText += text` → **누적만 하고 broadcast 없음**
- 결과: 응답이 끝날 때까지 Web UI / CLI / Telegram에 아무것도 안 보이다가 한번에 출력

---

## 근본 원인

`src/agent.js` L300-302:

```js
if (parsed.text) {
    ctx.fullText += parsed.text;
    // ← agent_chunk broadcast 없음!
}
```

다른 CLI들은 `child.stdout` NDJSON 파싱 중에 `broadcast('agent_chunk', { text })` 호출하지만,
ACP branch에서는 `session/update` → `extractFromAcpUpdate()` → `{ text }` 반환 시 broadcast 누락.

---

## 수정 계획

### [MODIFY] `src/agent.js` — ACP session/update 핸들러

```diff
 if (parsed.text) {
     ctx.fullText += parsed.text;
+    broadcast('agent_chunk', { text: parsed.text, agentId: agentLabel });
 }
```

**1줄 추가**로 해결. 기존 `agent_chunk` 이벤트 형식과 동일하게 broadcast하면:
- **Web UI**: `ws.onmessage` → `case 'agent_chunk'` → 실시간 텍스트 렌더링
- **CLI TUI**: `case 'agent_chunk'` → `process.stdout.write(msg.text)` 실시간 출력
- **Telegram**: tool handler가 아닌 최종 `agent_done`만 사용하므로 영향 없음

### 검증

1. `cli-claw serve` 재시작
2. Copilot으로 메시지 전송
3. Web UI + CLI에서 **글자 단위 실시간 스트리밍** 확인
