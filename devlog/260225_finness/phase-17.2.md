# Phase 17.2 — ACP 세션 리플레이 중 💭 이벤트 차단

> 문제: copilot `loadSession()` 시 ACP가 히스토리를 replay하면서 이전 💭 thinking이 다시 broadcast → UI 스팸
> 기존 dedup: L354-357에서 `fullText/toolLog/seenToolKeys` clear → 텍스트/도구는 리셋되지만 💭은 dedup 안 됨

---

## 현재 코드 (agent.js)

```js
// L312: session/update 핸들러
acp.on('session/update', (params) => {
    const parsed = extractFromAcpUpdate(params);
    if (parsed.tool?.icon === '💭') {
        ctx.thinkingBuf += parsed.tool.label;  // ← 리플레이 중에도 무조건 append
        return;
    }
    // ...
});

// L354: loadSession 후 리셋
ctx.fullText = '';
ctx.toolLog = [];
ctx.seenToolKeys.clear();
// ← thinkingBuf 초기화 없음
// ← loadSession 중 broadcast된 이벤트는 이미 WS로 나간 뒤
```

## 수정 계획

### 1. replayMode 플래그 추가 (agent.js)

```diff
+let replayMode = false;

 acp.on('session/update', (params) => {
+    if (replayMode) return;  // 리플레이 중 모든 이벤트 무시
     const parsed = extractFromAcpUpdate(params);
     // ...
 });

 // L343-351: loadSession 블록
+replayMode = true;
 if (isResume && session.session_id) {
     try { await acp.loadSession(session.session_id); }
     catch { await acp.createSession(settings.workingDir); }
 } else {
     await acp.createSession(settings.workingDir);
 }
+replayMode = false;

 // L354: 리셋 유지 (안전장치)
 ctx.fullText = '';
 ctx.toolLog = [];
 ctx.seenToolKeys.clear();
+ctx.thinkingBuf = '';
```

### 2. 영향

- `loadSession()` 중 `session/update` 이벤트 전부 무시 → UI에 이전 💭 안 보임
- `prompt()` 실행 후부터 정상 이벤트 수신 시작
- 기존 `ctx` 리셋 로직은 안전장치로 유지
