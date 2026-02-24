---
created: 2026-02-25
status: done
tags: [cli-claw, finness, phase-11, heartbeat, queue]
---
# Phase 11 (finness): Heartbeat Pending Queue

> 목적: heartbeat job이 에이전트 busy 중 도착하면 드랍 대신 pending 큐에 넣고, 끝나면 순차 실행
> 범위: `src/heartbeat.js`

---

## 0) 문제

```
[heartbeat:자동점검] skipped — busy
```

- `heartbeatBusy = true`이면 heartbeat job을 **완전 드랍**
- 에이전트가 오래 걸리면 heartbeat가 계속 씹힘
- 특히 copilot ACP는 20분까지 갈 수 있으므로 droprate ↑

---

## 1) 현재 로직

```js
// heartbeat.js L29-33
async function runHeartbeatJob(job) {
    if (heartbeatBusy) {
        console.log(`[heartbeat:${job.name}] skipped — busy`);
        return;  // ← 완전 드랍
    }
    heartbeatBusy = true;
    // ... 실행 ...
    finally { heartbeatBusy = false; }
}
```

---

## 2) 변경

### `src/heartbeat.js`

```diff
 let heartbeatBusy = false;
+const pendingJobs = [];

 async function runHeartbeatJob(job) {
     if (heartbeatBusy) {
-        console.log(`[heartbeat:${job.name}] skipped — busy`);
-        return;
+        if (!pendingJobs.some(j => j.id === job.id)) {
+            pendingJobs.push(job);
+            console.log(`[heartbeat:${job.name}] queued (${pendingJobs.length} pending)`);
+            broadcast('heartbeat_pending', { pending: pendingJobs.length });
+        } else {
+            console.log(`[heartbeat:${job.name}] already queued, skip`);
+        }
+        return;
     }
     heartbeatBusy = true;
     // ... 기존 로직 유지 ...
     } finally {
         heartbeatBusy = false;
+        drainPending();
     }
 }

+async function drainPending() {
+    if (pendingJobs.length === 0) return;
+    const next = pendingJobs.shift();
+    broadcast('heartbeat_pending', { pending: pendingJobs.length });
+    console.log(`[heartbeat:${next.name}] dequeued (${pendingJobs.length} remaining)`);
+    await runHeartbeatJob(next);
+}
```

### 핵심 포인트

| 항목 | 설명 |
|------|------|
| **dedupe** | 같은 `job.id`가 pending에 이미 있으면 중복 추가 안 함 |
| **순차 실행** | `drainPending` → `runHeartbeatJob` 재귀 호출로 자연스럽게 직렬화 |
| **broadcast** | `heartbeat_pending` 이벤트로 UI에 pending 수 전파 |
| **import 추가** | `bus.js`에서 `broadcast` import 필요 |

---

## 3) 검증

```bash
npm test                               # 기존 테스트 통과
DEBUG=1 node bin/cli-claw serve        # 수동 확인
```

- 긴 작업 실행 중 heartbeat tick → `queued (1 pending)` 로그
- 작업 완료 후 → `dequeued (0 remaining)` → pending job 실행
