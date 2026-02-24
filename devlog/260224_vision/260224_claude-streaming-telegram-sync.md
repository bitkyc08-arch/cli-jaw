# 260224 Claude 실시간 스트리밍 + 텔레그램 동기화

## 배경

Claude Code CLI의 `--output-format stream-json`은 기본적으로 턴 단위 이벤트만 발생시킴:
- `system` (초기화) → `assistant` (모든 블록 한꺼번에) → `result` (종료)
- Codex는 `item.started` → `item.completed` → `turn.completed` 등 액션 단위 이벤트 발생
- 결과적으로 Claude 사용 시 텔레그램/웹에서 중간 상태(thinking, tool use)가 안 보였음

## 해결: `--include-partial-messages` 발견

Claude CLI에 `--include-partial-messages` 플래그 존재 확인 (웹 검색 + `claude --help`).
이 플래그 사용 시 `stream_event` 타입 이벤트가 실시간으로 발생:

```
[21:50:26] ▶ BLOCK START: thinking          ← 💭 실시간
[21:50:27] ▶ BLOCK START: tool_use  Bash    ← 🔧 실시간
[21:50:27] ▶ BLOCK START: tool_use  Read    ← 🔧 실시간
[21:50:32] ▶ BLOCK START: text              ← 📝 실시간
[21:50:34] RESULT 3 turns, 11초
```

## 변경사항

### 1. Claude 실시간 스트리밍 (`agent.js`)

```diff
 case 'claude':
     return ['--print', '--verbose', '--output-format', 'stream-json',
+        '--include-partial-messages',
         ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
```
- `buildArgs()`와 `buildResumeArgs()` 양쪽에 추가
- `stream_event` 타입 이벤트로 `content_block_start` 수신 가능

### 2. `stream_event` 파싱 (`events.js`)

#### `logEventSummary` — 실시간 콘솔 로그
```js
if (event.type === 'stream_event' && event.event) {
    const inner = event.event;
    if (inner.type === 'content_block_start' && inner.content_block) {
        if (cb.type === 'tool_use') logLine(`🔧 ${cb.name}`);
        if (cb.type === 'thinking') logLine(`💭 thinking...`);
    }
}
```

#### `extractToolLabels` — 실시간 broadcast
- `stream_event` → `content_block_start`에서만 tool label 추출
- `assistant` bulk 이벤트에서는 추출 안 함 (중복 방지)
- 기존 `extractToolLabel` (단수) → `extractToolLabels` (복수, 배열 반환)로 리팩터
- 하위 호환: `extractToolLabel`은 첫 번째 label만 반환하는 래퍼로 유지

### 3. XML 태그 정리 (`agent.js`)

Claude 응답에 `<tool_call>`, `<tool_result>` XML 태그가 포함되어 텔레그램에서 깨지는 문제:

```js
const cleaned = (stripped || ctx.fullText.trim())
    .replace(/<\/?tool_call>/g, '')
    .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
```

### 4. 텔레그램 타임아웃 (`telegram.js`)

```diff
-const IDLE_TIMEOUT = 240000;  // 4분
+const IDLE_TIMEOUT = 1200000; // 20분
```
- Claude가 tool 여러 개 사용 시 4분으로는 부족
- 에러 메시지도 "4분 무응답" → "20분 무응답"으로 변경

### 5. 텔레그램 글로벌 포워딩 (`telegram.js`)

**새 기능**: 웹/CLI에서 온 응답도 텔레그램으로 자동 포워딩

```js
// Global Forwarding: non-Telegram responses → Telegram
if (settings.telegram?.forwardAll !== false) {
    addBroadcastListener((type, data) => {
        if (type !== 'agent_done') return;
        if (tgProcessing) return;  // 중복 방지
        // → lastChatId로 📡 접두사와 함께 전송
    });
}
```

- `tgProcessing` 플래그로 텔레그램 발 요청 중복 방지
- 비텔레그램 응답에는 📡 이모지 접두사 → 구분 용이
- `settings.telegram.forwardAll: false`로 비활성화 가능

### 6. CCS 완전 제거

- `~/.ccs/` 디렉토리 삭제
- `com.ccs.cliproxy.plist`, `com.ccs.thinking-wrapper.plist` LaunchAgent 삭제
- `ccs-wrapper/` 디렉토리 삭제
- `npm uninstall -g @kaitranntt/ccs`
- `opencode.json` → plugin-only 설정으로 복원
- `.zshrc`에 `unset ANTHROPIC_API_KEY` 추가 (auth conflict 방지)

## 포트 변경

| 포트 | 이전 | 현재 |
|------|------|------|
| 8317 | CLIProxyAPI | ❌ 미사용 |
| 8318 | thinking-wrapper | ❌ 삭제 |
| 8319 | CCS CLIProxy | ❌ 삭제 |

## 커밋 이력

1. `[agent] fix: Claude event parsing - broadcast all tool blocks + strip XML tags`
2. `[agent] config: telegram idle timeout 4min → 20min`
3. `[agent] feat: Claude stream_event parsing + --include-partial-messages`
4. `[agent] fix: remove duplicate Claude tool broadcast`
5. `[agent] feat: forward all responses to Telegram + fix duplicate tool status`

## 이벤트 플로우 (변경 후)

```
Claude CLI (--include-partial-messages)
  │
  ├─ stream_event: content_block_start type=thinking
  │   → events.js: logLine("💭 thinking...")
  │   → events.js: extractToolLabels → broadcast('agent_tool')
  │   → telegram.js: toolHandler → 🔄 status message 업데이트
  │
  ├─ stream_event: content_block_start type=tool_use name=Bash
  │   → events.js: logLine("🔧 Bash")
  │   → events.js: extractToolLabels → broadcast('agent_tool')
  │   → telegram.js: toolHandler → 🔄 status message 업데이트
  │
  ├─ assistant (bulk, 턴 끝)
  │   → extractFromEvent: fullText 수집 (tool labels는 스킵 — 중복 방지)
  │
  └─ result
      → agent.js: XML 태그 정리 → broadcast('agent_done')
      → telegram.js: 최종 응답 전송 + status message 삭제
      → telegram.js: 글로벌 포워더 (비텔레그램 소스인 경우 📡 포워딩)
```

## 알려진 제한

- Claude `stream-json`의 `content_block_delta`는 파싱하지 않음 (토큰 단위 텍스트 스트리밍)
  - 향후 필요 시 추가 가능하나 현재는 불필요
- OpenCode의 `stream_event` 지원 여부 미확인 (OpenCode는 자체 이벤트 포맷 사용)
