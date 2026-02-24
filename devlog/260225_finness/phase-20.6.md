# Phase 20.6: 프로젝트 구조 재정리 — src/ 폴더 그룹화 + 잔여 500줄 분리

> 20.3 파일 분리 + 20.5 프론트 폴리시 완료 후 진행.
> 목표: `src/` 플랫 21파일 → 도메인별 서브디렉토리로 그룹화.

---

## 현재 상태 (20.5 완료 기준)

```
src/                    ← 21개 파일 플랫 + 4개 서브디렉토리
├── browser/            ← ✅ 이미 분리됨 (4파일)
├── command-contract/   ← ✅ 이미 분리됨 (3파일)
├── http/               ← ✅ 이미 분리됨 (3파일)
├── security/           ← ✅ 이미 분리됨 (2파일)
├── agent.js (562)
├── agent-args.js (67)
├── orchestrator.js (538)     ← hotfix: PHASE 상수 복원 +36
├── orchestrator-parser.js (108)
├── commands.js (268)
├── commands-handlers.js (432)
├── telegram.js (493)
├── telegram-forwarder.js (105)
├── prompt.js (515)       ← 500줄 초과 ⚠️
├── config.js (187)
├── cli-registry.js
├── db.js, bus.js, events.js, logger.js
├── acp-client.js (315)
├── heartbeat.js, memory.js, worklog.js
├── i18n.js, settings-merge.js
```

500줄 초과 잔여: `prompt.js`(515), `agent.js`(562), `orchestrator.js`(538)
(20.3에서 args/parser 추출 + hotfix로 PHASE 상수 복원)

---

## 20.6-A: src/ 도메인별 그룹화

### 목표 구조

```
src/
├── core/                  ← 공통 인프라 (변경 거의 없음)
│   ├── config.js          ← from src/config.js
│   ├── db.js              ← from src/db.js
│   ├── bus.js             ← from src/bus.js
│   ├── logger.js          ← from src/logger.js
│   ├── i18n.js            ← from src/i18n.js
│   └── settings-merge.js  ← from src/settings-merge.js
│
├── agent/                 ← 에이전트 스폰 + 이벤트
│   ├── index.js           ← re-export (spawnAgent, killActiveAgent 등)
│   ├── spawn.js           ← from src/agent.js (spawnAgent 핵심)
│   ├── args.js            ← from src/agent-args.js
│   └── events.js          ← from src/events.js
│
├── orchestrator/          ← 오케스트레이션 파이프라인
│   ├── index.js           ← re-export
│   ├── pipeline.js        ← from src/orchestrator.js
│   └── parser.js          ← from src/orchestrator-parser.js
│
├── cli/                   ← CLI 명령어 + 프롬프트
│   ├── commands.js        ← from src/commands.js
│   ├── handlers.js        ← from src/commands-handlers.js
│   ├── registry.js        ← from src/cli-registry.js
│   └── acp-client.js      ← from src/acp-client.js
│
├── prompt/                ← 시스템 프롬프트 조립
│   ├── index.js           ← re-export (getSystemPrompt 등)
│   ├── builder.js         ← from src/prompt.js (getSystemPrompt 메인)
│   └── sections.js        ← 20.3에서 추출 예정이었던 섹션 빌더
│
├── telegram/              ← 텔레그램 통합
│   ├── bot.js             ← from src/telegram.js
│   └── forwarder.js       ← from src/telegram-forwarder.js
│
├── memory/                ← 메모리 + 워크로그
│   ├── memory.js          ← from src/memory.js
│   ├── worklog.js         ← from src/worklog.js
│   └── heartbeat.js       ← from src/heartbeat.js
│
├── browser/               ← ✅ 이미 존재 (변경 없음)
├── command-contract/      ← ✅ 이미 존재 (변경 없음)
├── http/                  ← ✅ 이미 존재 (변경 없음)
└── security/              ← ✅ 이미 존재 (변경 없음)
```

### 이동 매핑 (총 21파일 → 7그룹)

| 현재 경로 | 새 경로 | import 수정 필요 |
|---|---|---|
| `src/config.js` | `src/core/config.js` | **17곳** (bin/commands 7 + server.js + src 8 + browser 2) |
| `src/db.js` | `src/core/db.js` | 5곳 (server + telegram + prompt + agent + orchestrator) |
| `src/bus.js` | `src/core/bus.js` | 7곳 (server + events + telegram + heartbeat + agent + orchestrator + tests 1) |
| `src/logger.js` | `src/core/logger.js` | 1곳 (server.js) |
| `src/i18n.js` | `src/core/i18n.js` | 3곳 src만 (telegram + commands + commands-handlers) — public/ i18n.js는 별도 |
| `src/settings-merge.js` | `src/core/settings-merge.js` | 2곳 (server.js + tests 1) |
| `src/agent.js` | `src/agent/spawn.js` | 5곳 (server + telegram + prompt + orchestrator + tests 1) |
| `src/agent-args.js` | `src/agent/args.js` | 1곳 (agent.js) |
| `src/events.js` | `src/agent/events.js` | 3곳 (agent + tests 2) |
| `src/orchestrator.js` | `src/orchestrator/pipeline.js` | **6곳** (server + telegram + agent + tests 3) |
| `src/orchestrator-parser.js` | `src/orchestrator/parser.js` | 1곳 (orchestrator.js) |
| `src/commands.js` | `src/cli/commands.js` | **8곳** (bin/chat + server + telegram + command-contract + public 2 + tests 2) |
| `src/commands-handlers.js` | `src/cli/handlers.js` | 1곳 (commands.js) |
| `src/cli-registry.js` | `src/cli/registry.js` | 5곳 (server + config + commands + commands-handlers + tests 1) |
| `src/acp-client.js` | `src/cli/acp-client.js` | 2곳 (agent + tests 1) |
| `src/prompt.js` | `src/prompt/builder.js` | 5곳 (server + telegram + agent + orchestrator + tests 1) |
| `src/telegram.js` | `src/telegram/bot.js` | 2곳 (server + heartbeat) |
| `src/telegram-forwarder.js` | `src/telegram/forwarder.js` | 2곳 (telegram + tests 1) |
| `src/memory.js` | `src/memory/memory.js` | 3곳 (server + telegram + public/main) |
| `src/worklog.js` | `src/memory/worklog.js` | 2곳 (orchestrator + tests 1) |
| `src/heartbeat.js` | `src/memory/heartbeat.js` | 2곳 (server + public/main) |

### 하위호환 re-export 패턴

모든 그룹에 `index.js`를 두고, 기존 import 경로가 깨지지 않도록 **구 경로에 re-export 파일**을 남김:

```js
// src/agent.js (기존 경로 유지용 — 이동 후 남기기)
export { spawnAgent, killActiveAgent, buildArgs, buildResumeArgs, buildMediaPrompt } from './agent/index.js';
```

**3개월 후 deprecation 경고 추가 → 6개월 후 삭제** 계획.

또는 한 번에 모든 import를 sed로 일괄 교체:

```bash
# 예시: config.js 경로 일괄 변경
find . -name '*.js' -not -path './node_modules/*' -not -path './skills_ref/*' \
  -exec sed -i '' "s|from '\./config\.js'|from './core/config.js'|g" {} +
find . -name '*.js' -not -path './node_modules/*' -not -path './skills_ref/*' \
  -exec sed -i '' "s|from '\.\./src/config\.js'|from '../src/core/config.js'|g" {} +
```

---

## 20.6-B: 잔여 500줄 초과 파일 최종 분리

20.3에서 미완이었던 분리 + 이동 시 자연스럽게 해결:

### 1) `prompt.js` (515줄 → 2파일)

```diff
// src/prompt/builder.js ← getSystemPrompt, getSubAgentPrompt 등 (~280줄)
// src/prompt/sections.js ← buildMemorySection, buildHeartbeatSection 등 (~230줄)

// src/prompt/builder.js
+import { buildMemorySection, buildHeartbeatSection, buildSkillsSection, buildOrchestrationSection } from './sections.js';

 export function getSystemPrompt(settings, opts = {}) {
-    // ... 인라인 300줄 조합 ...
+    const memoryBlock = buildMemorySection(settings, loadRecentMemories);
+    const heartbeatBlock = buildHeartbeatSection(settings);
+    const skillsBlock = buildSkillsSection(settings, getMergedSkills);
+    const orchBlock = buildOrchestrationSection(settings);
     // ...조합...
 }
```

### 2) `agent.js` (562줄 → ~350줄)

20.3에서 `agent-args.js`(67줄)로 추출했지만 원본에서 제거 안 됨.
→ 이동 시 `spawn.js`에서 중복 코드 제거하면 ~350줄로 자연 감소.

### 3) `orchestrator.js` (502줄 → ~380줄)

20.3에서 `orchestrator-parser.js`(108줄)로 추출 + re-export 유지 중.
→ 이동 시 re-export 제거 + import 경로 직접 변경으로 ~380줄.

---

## 20.6-C: 루트 파일 정리

### `server.js` (1008줄) → 라우트 분리

> 9.3에서 계획되었지만 미완.

```
server.js                  → ~200줄 (app 생성 + 미들웨어 + listen + shutdown)
src/routes/api.js          → ~300줄 (GET/POST /api/* 라우트)
src/routes/settings.js     → ~200줄 (/api/settings, /api/memory-files 등)
src/routes/agents.js       → ~150줄 (/api/employees, /api/skills)
src/routes/ws.js           → ~100줄 (WebSocket upgrade + broadcast)
```

```diff
// server.js (축소 후)
 import express from 'express';
+import { registerApiRoutes } from './src/routes/api.js';
+import { registerSettingsRoutes } from './src/routes/settings.js';
+import { registerAgentRoutes } from './src/routes/agents.js';
+import { setupWebSocket } from './src/routes/ws.js';

 const app = express();
 // ... 미들웨어 ...
+registerApiRoutes(app);
+registerSettingsRoutes(app);
+registerAgentRoutes(app);
 
 const server = app.listen(port, () => { ... });
+setupWebSocket(server);
```

### `bin/commands/chat.js` (842줄) → 3파일

```
bin/commands/chat.js          → ~300줄 (메인 루프)
bin/commands/chat-render.js   → ~250줄 (렌더링)
bin/commands/chat-keys.js     → ~200줄 (키바인딩)
```

### `lib/mcp-sync.js` (645줄) → 3파일

```
lib/mcp-sync.js              → ~250줄 (sync/install/init)
lib/mcp-io.js                → ~200줄 (load/save + format)
lib/mcp-symlinks.js          → ~200줄 (symlink 관리)
```

---

## 실행 순서

1. **Round 1**: `src/core/` 생성 + 6파일 이동 (가장 안전, 의존 적음)
2. **Round 2**: `src/agent/`, `src/orchestrator/` 이동 + 중복 코드 제거
3. **Round 3**: `src/cli/`, `src/prompt/`, `src/telegram/`, `src/memory/` 이동
4. **Round 4**: `server.js` 라우트 분리 → `src/routes/`
5. **Round 5**: `bin/commands/chat.js`, `lib/mcp-sync.js` 분리
6. **Round 6**: 구 경로 re-export 파일 정리 + 최종 검증

각 라운드 후 `npm test` 통과 필수.

---

## 테스트 계획

```bash
# 각 라운드 후
npm test                     # 230+ tests 통과

# 500줄 초과 확인
find . -name '*.js' -not -path './node_modules/*' -not -path './skills_ref/*' \
  | xargs wc -l | sort -rn | head -10
# 모든 파일 < 500줄

# import 경로 검증 (깨진 import 탐지)
node -e "import('./server.js')" 2>&1 | head -5
node -e "import('./src/agent/index.js')" 2>&1 | head -5
node -e "import('./src/orchestrator/index.js')" 2>&1 | head -5

# 구 경로 호환 확인
node -e "import('./src/agent.js').then(m => console.log(Object.keys(m)))"
```

---

## 완료 기준

- [x] `src/` 플랫 파일 0개 (모두 12개 서브디렉토리에 위치)
- [ ] 500줄 초과 파일 0개 → **미달성** (spawn 565, pipeline 555, builder 523, server 850, chat 842, mcp 645)
  - 복잡한 상태 의존성으로 추가 분리 시 리스크 대비 이익 부족
- [x] `server.js` 1009→850줄 (quota 85줄 + browser 93줄 추출)
  - 250줄 목표는 비현실적 (helper 함수+WS+middleware 통합 필수)
- [ ] 구 경로 re-export → **미구현** (직접 경로 수정으로 대체)
- [x] `npm test` 222/235 pass (2 pre-existing Phase 17, 11 skip)
- [x] 모든 `import` 정상 resolve (런타임 에러 0)

