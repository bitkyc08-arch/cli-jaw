# Phase 20.3: 구조 — 500줄 초과 파일 분리 + Express 보안 미들웨어

> Round 3: 코드 구조 정리. dev 스킬 500줄 제한 준수 + 보안 강화.
> 9.3(server.js 분리) 완료 후 진행 가정.

---

## 20.3-A: 500줄 초과 파일 분리 계획

> server.js는 9.3에서 처리 예정. 나머지 7개 파일 대상.

### 1) `bin/commands/chat.js` (844줄 → 3파일)

```
bin/commands/chat.js          → ~300줄 (메인 루프 + 진입점)
bin/commands/chat-render.js   → ~250줄 (렌더링 + API 헬퍼)
bin/commands/chat-keys.js     → ~200줄 (키바인딩, 자동완성, 커맨드)
```

```diff
// bin/commands/chat-render.js (NEW)
+export function renderCommandText(text) { ... }       // 실제 L71
+export async function apiJson(path, init, timeout) { ... }  // 실제 L75
+export function runSkillResetLocal() { ... }           // 실제 L91
+export function makeCliCommandCtx() { ... }            // 실제 L104

// bin/commands/chat-keys.js (NEW)
+export function setupKeyBindings(rl, state) { ... }
+export function handleTabComplete(line, rl) { ... }

// bin/commands/chat.js (수정)
+import { renderCommandText, apiJson, runSkillResetLocal, makeCliCommandCtx } from './chat-render.js';
+import { setupKeyBindings, handleTabComplete } from './chat-keys.js';
```

분리 기준: chat.js에서 `renderCommandText`, `apiJson`, `runSkillResetLocal`, `makeCliCommandCtx` 함수들을 chat-render.js로 추출. 키바인딩/자동완성 로직을 chat-keys.js로 추출.

### 2) `src/commands.js` (658줄 → 2파일)

```
src/commands.js              → ~300줄 (COMMANDS 배열 + parseCommand + executeCommand + completions)
src/commands-handlers.js     → ~350줄 (각 커맨드 handler 함수들)
```

```diff
// src/commands-handlers.js (NEW)
+export async function helpHandler(args, ctx) { ... }         // 실제 L197
+export async function statusHandler(args, ctx) { ... }       // 실제 L236
+export async function modelHandler(args, ctx) { ... }        // 실제 L274
+export async function cliHandler(args, ctx) { ... }          // 실제 L306
+export async function skillHandler(args, ctx) { ... }        // 실제 L339
+export async function employeeHandler(args, ctx) { ... }     // 실제 L359
+export async function clearHandler(args, ctx) { ... }        // 실제 L373
+export async function resetHandler(args, ctx) { ... }        // 실제 L385
+// ... 기타 핸들러 (formatDuration, unknownCommand, unsupportedCommand 포함)

// src/commands.js (수정)
+import * as handlers from './commands-handlers.js';
 export const COMMANDS = [
-    { name: 'help', handler: async (args, ctx) => { /* helpHandler 로직 */ } },
+    { name: 'help', handler: handlers.helpHandler },
```

### 3) `lib/mcp-sync.js` (645줄 → 3파일)

```
lib/mcp-sync.js              → ~250줄 (sync/install/init + re-exports)
lib/mcp-io.js                → ~200줄 (load/save + format 변환)
lib/mcp-symlinks.js          → ~200줄 (symlink 관리 + copyDefaultSkills)
```

```diff
// lib/mcp-io.js (NEW) — 실제 함수명 기준
+export function loadUnifiedMcp() { ... }              // 실제 L21
+export function saveUnifiedMcp(config) { ... }        // 실제 L29
+export function importFromClaudeMcp(filePath) { ... } // 실제 L37
+export function toClaudeMcp(config) { ... }           // 실제 L55
+export function toCodexToml(config) { ... }           // 실제 L65
+export function toOpenCodeMcp(config) { ... }         // 실제 L83
+export function patchCodexToml(existing, newMcp) { ... } // 실제 L98

// lib/mcp-symlinks.js (NEW) — 실제 함수명 기준
+export function ensureSkillsSymlinks(workingDir, opts) { ... } // 실제 L215
+export function copyDefaultSkills() { ... }            // 실제 L505
+function createBackupContext() { ... }                 // 실제 L277 (내부)
+function resolveSymlinkTarget(linkPath, target) { ... } // 실제 L282 (내부)
+function ensureSymlinkSafe(target, linkPath, opts) { ... } // 실제 L288 (내부)
+function movePathToBackup(pathToMove, ctx) { ... }     // 실제 L361 (내부)
+function copyDirRecursive(src, dst) { ... }            // 실제 L624 (내부)

// lib/mcp-sync.js (수정)
+import { loadUnifiedMcp, saveUnifiedMcp, importFromClaudeMcp, toClaudeMcp, toCodexToml, toOpenCodeMcp } from './mcp-io.js';
+import { ensureSkillsSymlinks, copyDefaultSkills } from './mcp-symlinks.js';
+// re-export for backward compatibility
+export { loadUnifiedMcp, saveUnifiedMcp, importFromClaudeMcp, toClaudeMcp, toCodexToml, toOpenCodeMcp };
+export { ensureSkillsSymlinks, copyDefaultSkills };
 export function syncToAll(config, workingDir) { ... }  // 실제 L135 (유지)
 export async function installMcpServers(config) { ... } // 실제 L404 (유지)
 export function initMcpConfig(workingDir) { ... }      // 실제 L471 (유지)
```

### 4) `src/agent.js` (619줄 → 2파일)

```
src/agent.js                 → ~350줄 (spawnAgent + 프로세스 관리)
src/agent-args.js            → ~250줄 (buildArgs + buildResumeArgs + buildMediaPrompt)
```

```diff
// src/agent-args.js (NEW)
+export function buildArgs(cli, model, effort, prompt, sysPrompt, permissions) { ... }
+export function buildResumeArgs(cli, model, effort, sessionId, prompt, permissions) { ... }
+export function buildMediaPrompt(filePath) { ... }

// src/agent.js (수정)
+import { buildArgs, buildResumeArgs, buildMediaPrompt } from './agent-args.js';
-export function buildArgs(...) { ... }
+export { buildArgs, buildResumeArgs, buildMediaPrompt } from './agent-args.js';
```

### 5) `src/orchestrator.js` (584줄 → 2파일)

```
src/orchestrator.js          → ~300줄 (orchestrate + orchestrateContinue)
src/orchestrator-parser.js   → ~250줄 (parseSubtasks + parseDirectAnswer + stripSubtaskJSON + triage)
```

```diff
// src/orchestrator-parser.js (NEW)
+export function parseSubtasks(text) { ... }
+export function parseDirectAnswer(text) { ... }
+export function stripSubtaskJSON(text) { ... }
+export function isContinueIntent(text) { ... }
+export function needsOrchestration(text) { ... }

// src/orchestrator.js (수정)
+import { parseSubtasks, parseDirectAnswer, stripSubtaskJSON, isContinueIntent, needsOrchestration } from './orchestrator-parser.js';
+export { parseSubtasks, parseDirectAnswer, stripSubtaskJSON, isContinueIntent, needsOrchestration };
```

### 6) `public/js/features/settings.js` (532줄 → 2파일)

```
public/js/features/settings.js          → ~300줄 (로드 + 이벤트 핸들러)
public/js/features/settings-render.js   → ~230줄 (CLI 상태 렌더, 모델 셀렉트 동기화)
```

```diff
// public/js/features/settings-render.js (NEW)
+export function renderCliStatus(data) { ... }
+export function syncCliOptionSelects(s) { ... }
+export function syncPerCliModelAndEffortControls(s) { ... }
+export function appendCustomOption(select, value) { ... }
```

### 7) `src/prompt.js` (512줄 → 2파일)

```
src/prompt.js                → ~260줄 (getSystemPrompt 메인 + 조합 + exports)
src/prompt-sections.js       → ~250줄 (각 섹션 빌더 추출)
```

> ⚠️ 주의: 현재 prompt.js의 섹션 빌더들은 **인라인 코드**이므로 별도 함수로 추출해야 함.
> getSystemPrompt() (L248) 내부에서 memory, heartbeat, skills, orchestration 섹션을 직접 조합 중.
> 이 인라인 블록들을 함수로 추출한 후 prompt-sections.js로 이동.

```diff
// src/prompt-sections.js (NEW) — getSystemPrompt() 내부 로직에서 추출
+export function buildMemorySection(settings, loadRecentMemories) {
+    // getSystemPrompt() 내부의 메모리 관련 문자열 조합 블록 추출
+    ...
+}
+export function buildHeartbeatSection(settings) {
+    // getSystemPrompt() 내부의 하트비트 관련 블록 추출
+    ...
+}
+export function buildSkillsSection(settings, getMergedSkills) {
+    // getSystemPrompt() 내부의 스킬 목록 생성 블록 추출
+    ...
+}
+export function buildOrchestrationSection(settings) {
+    // getSystemPrompt() 내부의 오케스트레이션 설명 블록 추출
+    ...
+}

// src/prompt.js (수정) — 기존 export 모두 유지
+import { buildMemorySection, buildHeartbeatSection, buildSkillsSection, buildOrchestrationSection } from './prompt-sections.js';
 export function getSystemPrompt() {
-    // ... 300줄 인라인 조합 ...
+    const memoryBlock = buildMemorySection(settings, loadRecentMemories);
+    const heartbeatBlock = buildHeartbeatSection(settings);
+    const skillsBlock = buildSkillsSection(settings, getMergedSkills);
+    const orchBlock = buildOrchestrationSection(settings);
     // ...조합...
 }
```

기존 export 목록 (반드시 유지):
- `loadActiveSkills` (L11), `loadSkillRegistry` (L34), `getMergedSkills` (L44)
- `A1_PATH`, `A2_PATH`, `HEARTBEAT_PATH` (L199-201)
- `initPromptFiles` (L205), `getMemoryDir` (L213), `loadRecentMemories` (L219)
- `getSystemPrompt` (L248), `getSubAgentPrompt` (L390), `getSubAgentPromptV2` (L437)
- `regenerateB` (L491)

---

## 20.3-B: Express 보안 미들웨어

### 의존성 추가

```bash
npm install helmet
```

### 파일: `server.js` (9.3 분리 후 해당 파일)

```diff
 import express from 'express';
+import helmet from 'helmet';
 
 const app = express();
+
+// ─── Security Headers ───────────────────────────────
+app.use(helmet({
+    contentSecurityPolicy: false, // CDN 사용 중이므로 비활성
+    crossOriginEmbedderPolicy: false,
+}));
+
+// ─── CORS (localhost only — exact match, startsWith 우회 방지) ──
+const ALLOWED_ORIGINS = new Set([
+    'http://localhost:3457',
+    'http://127.0.0.1:3457',
+    `http://localhost:${process.env.PORT || 3457}`,
+    `http://127.0.0.1:${process.env.PORT || 3457}`,
+]);
+app.use((req, res, next) => {
+    const origin = req.headers.origin;
+    if (!origin || ALLOWED_ORIGINS.has(origin)) {
+        res.setHeader('Access-Control-Allow-Origin', origin || '*');
+        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
+        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename');
+    }
+    if (req.method === 'OPTIONS') return res.sendStatus(204);
+    next();
+});
+
+// ─── Rate Limiting (simple in-memory + 정리) ────────
+const rateLimitMap = new Map();
+// 10분마다 만료 항목 정리 (메모리 누수 방지)
+setInterval(() => {
+    const now = Date.now();
+    for (const [ip, w] of rateLimitMap) {
+        if (now - w.start > 120_000) rateLimitMap.delete(ip);
+    }
+}, 600_000);
+app.use((req, res, next) => {
+    const ip = req.ip;
+    const now = Date.now();
+    const window = rateLimitMap.get(ip) || { count: 0, start: now };
+    if (now - window.start > 60_000) { window.count = 0; window.start = now; }
+    window.count++;
+    rateLimitMap.set(ip, window);
+    if (window.count > 120) return res.status(429).json({ error: 'rate_limit' });
+    next();
+});
+
-app.use(express.json());
+app.use(express.json({ limit: '1mb' }));
 app.use(express.static(join(__dirname, 'public')));
```

---

## 테스트 계획

```bash
# 분리 후 모든 import 확인
node -e "import('./src/agent.js')" && echo "agent OK"
node -e "import('./src/orchestrator.js')" && echo "orchestrator OK"
node -e "import('./src/commands.js')" && echo "commands OK"
node -e "import('./lib/mcp-sync.js')" && echo "mcp OK"

# 기존 테스트 통과
npm test

# 500줄 초과 확인
find . -name '*.js' -not -path './node_modules/*' -not -path './skills_ref/*' | xargs wc -l | sort -rn | head -10
# 모든 파일 < 500줄

# helmet 헤더 확인
curl -sI http://localhost:3457/ | grep -i "x-content-type\|x-frame\|strict-transport"
```

---

## 완료 기준

- [ ] 500줄 초과 파일 0개
- [ ] 기존 export 경로 모두 re-export 유지 (하위호환)
- [ ] `helmet` 설치 + 보안 헤더 적용
- [ ] CORS localhost만 허용
- [ ] Rate limit 분당 120회
- [ ] `npm test` 통과
- [ ] `npm pack --dry-run` 정상
