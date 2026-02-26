# Phase 4: Intent 감지 + orchestrateReset

## 대상 파일
- `src/orchestrator/parser.ts` — continue 패턴 확장 + `isResetIntent` [NEW]
- `src/orchestrator/pipeline.ts` — import 수정 + `orchestrateReset` [NEW]
- `server.ts` — `/api/orchestrate/reset` 엔드포인트

---

## 4-A. parser.ts continue 패턴 확장 (L5-9)

### 현재 코드

```typescript
const CONTINUE_PATTERNS = [
    /^\/?continue$/i,
    /^이어서(?:\s*해줘)?$/i,
    /^계속(?:\s*해줘)?$/i,
];
```

### Diff

```diff
 const CONTINUE_PATTERNS = [
     /^\/?continue$/i,
     /^이어서(?:\s*해줘)?$/i,
     /^계속(?:\s*해줘)?$/i,
+    /^다음(?:\s*해봐)?$/i,
+    /^리뷰(?:\s*해봐)?$/i,
 ];
```

---

## 4-B. parser.ts isResetIntent [NEW] (L15 뒤)

```typescript
const RESET_PATTERNS = [
    /^리셋해?$/i,
    /^초기화해?$/i,
    /^페이즈?\s*리셋해?$/i,
    /^phase\s*reset$/i,
    /^reset$/i,
];

export function isResetIntent(text: string) {
    const t = String(text || '').trim();
    if (!t) return false;
    return RESET_PATTERNS.some(re => re.test(t));
}
```

---

## 4-C. pipeline.ts import 수정 (L20-24)

### 현재 코드

```typescript
import {
    isContinueIntent, needsOrchestration,
    parseSubtasks, parseDirectAnswer, stripSubtaskJSON, parseVerdicts,
} from './parser.js';
export { isContinueIntent, needsOrchestration, parseSubtasks, parseDirectAnswer, stripSubtaskJSON };
```

### Diff

```diff
 import {
-    isContinueIntent, needsOrchestration,
+    isContinueIntent, isResetIntent, needsOrchestration,
     parseSubtasks, parseDirectAnswer, stripSubtaskJSON, parseVerdicts,
 } from './parser.js';
-export { isContinueIntent, needsOrchestration, parseSubtasks, parseDirectAnswer, stripSubtaskJSON };
+export { isContinueIntent, isResetIntent, needsOrchestration, parseSubtasks, parseDirectAnswer, stripSubtaskJSON };
```

---

## 4-D. pipeline.ts orchestrateReset [NEW] (L407 뒤)

```typescript
export async function orchestrateReset(meta: Record<string, any> = {}) {
    const origin = meta.origin || 'web';
    clearAllEmployeeSessions.run();
    const latest = readLatestWorklog();
    if (!latest) {
        broadcast('orchestrate_done', { text: '리셋할 worklog가 없습니다.', origin });
        return;
    }
    updateWorklogStatus(latest.path, 'reset', 0);
    appendToWorklog(latest.path, 'Final Summary', '유저 요청으로 리셋됨.');
    broadcast('orchestrate_done', { text: '리셋 완료.', origin });
}
```

---

## 4-E. server.ts 엔드포인트 (L410 뒤)

```typescript
app.post('/api/orchestrate/reset', (req, res) => {
    orchestrateReset({ origin: 'web' });
    res.json({ ok: true });
});
```

import에 `orchestrateReset` 추가:

```diff
-import { orchestrate, orchestrateContinue, ... } from '...';
+import { orchestrate, orchestrateContinue, orchestrateReset, ... } from '...';
```

---

## 검증

```
IN-001: "리뷰해봐" → isContinueIntent true
IN-002: "다음 해봐" → isContinueIntent true
IN-003: "이어서 해줘" → isContinueIntent true (기존)
IN-004: "리셋해" → isResetIntent true
IN-005: "리셋" → isResetIntent true
IN-006: "리셋해줘" → isResetIntent false
IN-007: "phase reset" → isResetIntent true
IN-008: "reset" → isResetIntent true
RS-001: reset → clearSessions + worklog reset
RS-002: reset 대상 없음 → 에러 메시지
RS-003: reset 후 continue → "이어갈 작업 없음"
```
