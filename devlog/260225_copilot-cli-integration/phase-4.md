# Phase 4: events.js ACP 파싱

> 예상 시간: 30분
> 핵심: ACP `session/update` → cli-claw broadcast 이벤트 변환

---

## 4.1 ACP 이벤트 → cli-claw 매핑

> `params.update.sessionUpdate` discriminator 사용 (공식 schema.json 확인됨)

```
ACP session/update                  →  cli-claw broadcast
──────────────────────────────────────────────────────
sessionUpdate: 'agent_thought_chunk' →  agent_tool { icon: '💭' }
sessionUpdate: 'tool_call'           →  agent_tool { icon: '🔧', label: name }
sessionUpdate: 'tool_call_update'    →  agent_tool { icon: '✅', label: name }
sessionUpdate: 'agent_message_chunk' →  fullText에 누적 (ws.js가 agent_output으로)
session/prompt result (stopReason)   →  agent_done { text: fullText, toolLog }
```

> **확정됨**: `params.update.sessionUpdate`가 discriminator 필드 (공식 schema.json)
> `kind` / `type`이 아님! `update.sessionUpdate`로 접근.

---

## 4.2 `src/events.js` — 새 함수 추가

### `extractFromAcpUpdate(params)`

```js
/**
 * ACP session/update 이벤트 → cli-claw 내부 이벤트
 * @param {Object} params - session/update notification의 params
 *   params.update.sessionUpdate = discriminator
 * @returns {{ tool?: Object, text?: string, done?: boolean } | null}
 */
export function extractFromAcpUpdate(params) {
    const update = params?.update;
    if (!update) return null;

    const type = update.sessionUpdate;

    switch (type) {
        case 'agent_thought_chunk': {
            // ContentChunk: update.content = [{type: 'text', text: '...'}]
            const text = extractText(update.content);
            return {
                tool: {
                    icon: '💭',
                    label: text.slice(0, 60) + (text.length > 60 ? '...' : '') || 'thinking...'
                }
            };
        }

        case 'tool_call':
            return {
                tool: {
                    icon: '🔧',
                    label: update.name || 'tool',
                }
            };

        case 'tool_call_update':
            return {
                tool: {
                    icon: '✅',
                    label: update.name || update.id || 'done',
                }
            };

        case 'agent_message_chunk': {
            const text = extractText(update.content);
            return { text };
        }

        case 'plan':
            return {
                tool: {
                    icon: '📝',
                    label: 'planning...',
                }
            };

        default:
            if (process.env.DEBUG) {
                console.log(`[acp] unknown sessionUpdate: ${type}`, update);
            }
            return null;
    }
}

// ContentChunk.content 에서 텍스트 추출 (content가 string/array/object일 수 있음)
function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('');
    }
    return '';
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

## 4.3 ContentChunk 검증 메모 (Phase 2 이후)

Phase 2 테스트에서 캡처한 실제 `session/update` 메시지:

```json
// Phase 2 실행 후 캡처된 실제 데이터로 대체 예정
// 확인 포인트: update.content 배열 구조, ToolCall 필드명
```

---

## Phase 4 테스트

```bash
# Phase 3과 통합 후 테스트

# 1. tool use가 발생하는 프롬프트
curl -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "list files in current directory"}'

# 확인:
# - 🔧 tool 이벤트가 WebSocket으로 브로드캐스트 되는지
# - 💭 thinking 이벤트 표시 (모델에 따라)
# - 텍스트 청크가 실시간으로 도착하는지
# - 최종 agent_done에 전체 텍스트가 있는지

# 2. 텔레그램에서 동일 프롬프트 전송
# - 중간 이벤트가 Telegram에 전달되는지 확인
```

- [ ] agent_thought_chunk 이벤트 → 💭 broadcast
- [ ] tool_call 이벤트 → 🔧 broadcast
- [ ] agent_message_chunk 이벤트 → agent_output (웹) / agent_chunk (텔레그램)
- [ ] session/prompt result → agent_done broadcast
- [ ] 알 수 없는 sessionUpdate → 조용히 무시 (DEBUG 시 로그)
