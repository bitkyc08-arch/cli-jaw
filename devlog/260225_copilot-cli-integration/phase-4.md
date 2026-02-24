# Phase 4: events.js ACP 파싱

> 예상 시간: 30분
> 핵심: ACP `session/update` → cli-claw broadcast 이벤트 변환

---

## 4.1 ACP 이벤트 → cli-claw 매핑

> ⚠️ 아래 `params` 구조는 Phase 2 캡처 결과로 확정. 현재는 추정.

```
ACP session/update               →  cli-claw broadcast
─────────────────────────────────────────────────────
kind: 'thinking'                 →  agent_tool { icon: '💭', label: ... }
kind: 'tool_use'                 →  agent_tool { icon: '🔧', label: toolName }
kind: 'tool_result'              →  agent_tool { icon: '✅', label: toolName }
kind: 'text'                     →  agent_chunk { text: ... }
kind: 'complete'                 →  agent_done { text: fullText }
```

---

## 4.2 `src/events.js` — 새 함수 추가

### `extractFromAcpUpdate(params)`

```js
/**
 * ACP session/update 이벤트 → cli-claw 내부 이벤트
 * @param {Object} params - session/update notification의 params
 * @returns {{ tool?: Object, text?: string, done?: boolean } | null}
 */
export function extractFromAcpUpdate(params) {
    // Phase 2 캡처 결과에 따라 구조 확정
    // 아래는 ACP 스펙 기반 추정
    const kind = params?.kind || params?.type || params?.event;
    const content = params?.content || params?.text || '';

    switch (kind) {
        case 'thinking':
        case 'reasoning':
            return {
                tool: {
                    icon: '💭',
                    label: typeof content === 'string'
                        ? content.slice(0, 60) + (content.length > 60 ? '...' : '')
                        : 'thinking...'
                }
            };

        case 'tool_use':
        case 'tool_call':
            return {
                tool: {
                    icon: '🔧',
                    label: params?.name || params?.toolName || 'tool',
                }
            };

        case 'tool_result':
            return {
                tool: {
                    icon: '✅',
                    label: params?.name || params?.toolName || 'done',
                }
            };

        case 'text':
        case 'content':
        case 'assistant_message_delta':
            return { text: content };

        case 'complete':
        case 'done':
        case 'end':
            return { done: true };

        default:
            // 알 수 없는 이벤트 → 무시하되 로그
            if (process.env.DEBUG) {
                console.log(`[acp] unknown update kind: ${kind}`, params);
            }
            return null;
    }
}
```

### `logEventSummary()` 에 copilot case

```js
// 기존 extractFromEvent 내부 또는 별도
if (cli === 'copilot') {
    // copilot은 ACP 이벤트를 직접 처리하므로
    // extractFromEvent를 경유하지 않음
    // agent.js에서 직접 extractFromAcpUpdate 호출
    return null;
}
```

---

## 4.3 스키마 확정 메모 (Phase 2 이후 업데이트)

Phase 2 테스트에서 캡처한 실제 `session/update` 메시지:

```json
// TODO: Phase 2 실행 후 여기에 실제 캡처 결과 붙여넣기
{
    "jsonrpc": "2.0",
    "method": "session/update",
    "params": {
        "??": "??"
    }
}
```

---

## Phase 4 테스트

```bash
# Phase 3과 통합 후 테스트

# 1. tool use가 발생하는 프롬프트
curl -X POST http://localhost:4280/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "list files in current directory", "cli": "copilot", "model": "gpt-4.1"}'

# 확인:
# - 🔧 tool 이벤트가 WebSocket으로 브로드캐스트 되는지
# - 💭 thinking 이벤트 표시 (모델에 따라)
# - 텍스트 청크가 실시간으로 도착하는지
# - 최종 agent_done에 전체 텍스트가 있는지

# 2. 텔레그램에서 동일 프롬프트 전송
# - 중간 이벤트가 Telegram에 전달되는지 확인
```

### 확인 사항
- [ ] thinking 이벤트 → 💭 broadcast
- [ ] tool_use 이벤트 → 🔧 broadcast
- [ ] text 이벤트 → agent_chunk broadcast
- [ ] complete → agent_done broadcast
- [ ] 알 수 없는 이벤트 → 조용히 무시 (DEBUG 시 로그)
