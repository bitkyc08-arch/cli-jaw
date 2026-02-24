# Phase 5.2 ~ 5.4 (finness): Thinking Merge + UI 버그 수정 + Dedupe 통합

> 완료: 2026-02-25T01:52

---

## 5.2 — 💭 Thinking Chunk Merge

### 문제
Copilot ACP `agent_thought_chunk` 이벤트가 60+개 flood → 전체 차단 → 진행상황 0

### 수정 (`agent.js`)
- `ctx.thinkingBuf` 누적 → 다른 이벤트 도착 시 `flushThinking()` 1회 merge 방출
- 200자 제한 (앞부분 truncate), 서버 로그 120자 출력
- exit 핸들러에서도 남은 buf flush
- **프론트엔드/Telegram 변경 0줄** — 기존 `agent_tool` 이벤트 재사용

### 동작
```
🔧 Read file
💭 Let me think... I need to consider... OK my plan is...  ← 60개→1건
🔧 Edit file
💭 Now let me verify... I should check...                   ← 1건
📝 완료
```

커밋: `500f697`, `6f563ab` (서버 로그 추가)

---

## 5.3 — Refresh 버튼 → 채팅 클리어 버그

### 문제
CLI Status를 왼쪽 사이드바로 옮긴 후, `refreshCli` 버튼(`.btn-clear`)이 `/clear` 버튼보다 **DOM에서 먼저** 위치 → `querySelector('.btn-clear')`가 refresh 버튼을 잡아서 `clearChat` 바인딩

### 수정
- `/clear` 버튼에 `id="btnClearChat"` 추가
- `main.js`: `querySelector('.btn-clear')` → `getElementById('btnClearChat')`

### querySelector 전체 감사 결과
| 셀렉터 | 위험도 | 이유 |
|--------|--------|------|
| `.btn-clear` | ❌→✅ 수정됨 | 7곳 사용, DOM 순서 의존 |
| `.btn-attach` | ✅ 안전 | 1개만 존재 |
| `.tab-bar` | ✅ 안전 | 1개만 존재 |
| `.sidebar-save-bar .btn-save` | ✅ 안전 | 복합 셀렉터 |
| `[data-action="..."]` | ✅ 안전 | 고유 attribute |
| `.file-preview .remove` | ✅ 안전 | 복합 셀렉터 |

커밋: `5d5b00b`

---

## 5.4 — Spawn 경로 Tool Dedupe 누락

### 문제
ACP 경로: `seenToolKeys` Set으로 dedupe ✅
Spawn 경로 (`extractFromEvent`): dedupe 없이 바로 `toolLog.push` + `broadcast` ❌

**영향 범위:**
| CLI | thinking 타입 | 레이블 | flood 위험 |
|-----|--------------|--------|-----------|
| Claude | `thinking` (content_block_start) | 고정 `thinking...` | ❌ 낮음 (같은 키) |
| Codex | `reasoning` (item.completed) | **동적 텍스트** | ⚠️ **있음** |
| Gemini | 없음 | — | ❌ |
| OpenCode | 없음 | — | ❌ |
| Copilot | ACP `agent_thought_chunk` | thinkingBuf merge | ✅ 이미 처리 |

Codex `reasoning` → 매 이벤트마다 다른 텍스트 → 매번 새 키 생성 → flood 가능

### 수정 (`events.js` `extractFromEvent`)
```diff
 for (const toolLabel of toolLabels) {
+    const key = `${toolLabel.icon}:${toolLabel.label}`;
+    if (ctx.seenToolKeys?.has(key)) continue;
+    ctx.seenToolKeys?.add(key);
     ctx.toolLog.push(toolLabel);
     broadcast('agent_tool', { ... });
 }
```

→ Spawn 경로도 ACP 경로와 동일한 dedupe 적용. Codex reasoning 중복 방지.

---

## Settings 탭 쿼타 갱신 제거

- `ui.js`: Settings 탭 열 때 `loadCliStatus()` → `loadSettings()` 변경
- CLI 상태/쿼타는 왼쪽 사이드바에서만 갱신 (bootstrap + 🔄 버튼)
- 커밋: `30dd47f`
