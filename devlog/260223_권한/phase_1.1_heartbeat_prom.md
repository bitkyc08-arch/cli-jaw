# Phase 1.1: Heartbeat 프롬프트 주입

## 문제

AI 에이전트가 heartbeat 시스템의 존재와 API를 모름.
→ "5분마다 서버 상태 체크해줘" 같은 요청을 처리 못함.

## 현재 구조

```
프롬프트 생성 흐름:
  A-1.md (코어 규칙)        ← L66, "HEARTBEAT_OK" 한 줄만 언급
  + A-2.md (유저 설정)       ← L87
  + Employees (DB 기반)     ← L167, getSystemPrompt()에서 동적 주입
  + Memory (Claude 메모리)  ← L163
  → B.md (최종 합체)         ← L196, regenerateB()
  → spawnAgent stdin        ← L634, stdinContent에 B.md 삽입
```

```
Heartbeat 시스템:
  ~/.cli-claw/heartbeat.json  ← jobs 배열 (id, name, enabled, schedule, prompt)
  API: GET/PUT /api/heartbeat ← Web UI에서 관리
  fs.watch → 자동 리로드
  runHeartbeatJob → orchestrateAndCollect → 응답을 Telegram으로 전송
```

## 삽입 지점 분석

### A1 (코어 규칙) — L66
현재: "HEARTBEAT_OK" 한 줄만 있음
**→ 여기에 heartbeat API 사용법 + JSON 포맷 추가**

### A2 (유저 설정) — L87
유저 개인화 영역. heartbeat와 직접 관련 없음.
**→ 건드리지 않음**

### B.md (합체) — L158 `getSystemPrompt()`
Employees처럼 **heartbeat.json의 현재 상태를 동적 주입**.
**→ 여기에 현재 등록된 jobs 목록 + 등록 방법 추가**

### 추가 삽입 지점: spawnAgent stdin — L634
실행 시 B.md + context를 stdin으로 전달.
**→ 건드리지 않음** (B.md에서 처리)

## 구현 계획

### 1. A1에 Heartbeat 시스템 설명 추가

```diff
  # Claw Agent
  ...
  - If nothing needs attention on heartbeat, reply HEARTBEAT_OK
+
+ ## Heartbeat System
+ You can register recurring tasks using the heartbeat API.
+ To register a new heartbeat job, write to ~/.cli-claw/heartbeat.json:
+
+ ```json
+ {
+   "jobs": [
+     {
+       "id": "hb_TIMESTAMP",
+       "name": "작업 이름",
+       "enabled": true,
+       "schedule": { "kind": "every", "minutes": 5 },
+       "prompt": "실행할 프롬프트"
+     }
+   ]
+ }
+ ```
+
+ The file is auto-reloaded on change. Each job runs on schedule and results are sent to Telegram.
+ If nothing needs attention on heartbeat, reply [SILENT].
```

### 2. getSystemPrompt()에 현재 heartbeat 상태 주입

```javascript
// Phase 1.1: Heartbeat state injection
try {
    const hbData = loadHeartbeatFile();
    const activeJobs = hbData.jobs.filter(j => j.enabled);
    if (hbData.jobs.length > 0) {
        prompt += '\n\n---\n## Current Heartbeat Jobs\n';
        for (const job of hbData.jobs) {
            const status = job.enabled ? '✅' : '⏸️';
            const mins = job.schedule?.minutes || '?';
            prompt += `- ${status} "${job.name}" — every ${mins}min: ${(job.prompt || '').slice(0, 50)}\n`;
        }
        prompt += `\nActive: ${activeJobs.length}, Total: ${hbData.jobs.length}`;
        prompt += '\nTo modify: edit ~/.cli-claw/heartbeat.json (auto-reloads on save)';
    }
} catch { }
```

## 파일 변경

| 파일             | 변경                                         |
| ---------------- | -------------------------------------------- |
| `server.js` L66  | A1_CONTENT에 Heartbeat 시스템 설명 추가      |
| `server.js` L158 | getSystemPrompt()에 heartbeat 상태 동적 주입 |
| devlog           | 이 문서                                      |

## 체크리스트

- [ ] A1_CONTENT 수정 — heartbeat 설명 + JSON 포맷
- [ ] getSystemPrompt() — heartbeat 상태 주입
- [ ] regenerateB() 호출 확인
- [ ] 테스트: 에이전트에게 "heartbeat 등록해줘" 요청
