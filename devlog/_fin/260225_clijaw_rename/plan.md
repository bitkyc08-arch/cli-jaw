# 260225 cli-jaw Rename — 전체 리네이밍 계획서

> **cli-claw → cli-jaw** | **Claw → Jaw** | **🦞 → 🦈**
> "cli-jaw" = CLI + Jaw(턱) = 상어 🦈 테마

## npm / 저작권 확인
- `cli-jaw` — npm 404 (사용 가능) ✅ 상표 충돌 없음
- `cli-jaws` — ⚠️ JAWS(Freedom Scientific) 등록 상표, 스크린 리더와 혼동 가능 → 사용 안 함
- **최종 선택: `cli-jaw`** — 짧고 깔끔, 리스크 제로

---

## 네이밍 변환 테이블

| Before | After | 비고 |
|--------|-------|------|
| `cli-claw` | `cli-jaw` | CLI 명령어, npm 패키지명 |
| `cli-claw-ts` | `cli-jaw` | npm package name |
| `CLI-Claw` | `cli-jaw` | 타이틀 케이스 |
| `Claw Agent` | `Jaw Agent` | 에이전트 이름 |
| `CLAW_HOME` | `JAW_HOME` | 코드 변수 |
| `claw.db` | `jaw.db` | SQLite DB |
| `~/.cli-claw/` | `~/.cli-jaw/` | 런타임 디렉토리 |
| `/api/claw-memory/*` | `/api/jaw-memory/*` | API 라우트 |
| `🦞` | `🦈` | 이모지 |
| `[claw:xxx]` | `[jaw:xxx]` | 로그 prefix |
| `CliClaw` | `CliJaw` | PascalCase |
| `clawHome` | `jawHome` | camelCase |

### 변환하지 않는 것
- `OpenClaw` / `OPENCLAW_ACTIVE` — 외부 프로젝트명, 유지
- `Clawdbot` — 외부 봇 이름, 유지
- `Cliclaw` — 노션 내 별도 프로젝트명, 유지
- `devlog/_fin/` — 과거 히스토리, 건드리지 않음
- `dist/` — 빌드 산출물, 자동 재생성
- `package-lock.json` — npm install 시 자동 갱신

---

## Phase 1: 핵심 설정 (`src/core/config.ts`)

모든 파일이 여기서 경로를 import하므로 최우선 변경.

```diff
--- src/core/config.ts
+++ src/core/config.ts
@@ -27,14 +27,14 @@
-export const CLAW_HOME = join(os.homedir(), '.cli-claw');
-export const PROMPTS_DIR = join(CLAW_HOME, 'prompts');
-export const DB_PATH = join(CLAW_HOME, 'claw.db');
-export const SETTINGS_PATH = join(CLAW_HOME, 'settings.json');
-export const HEARTBEAT_JOBS_PATH = join(CLAW_HOME, 'heartbeat.json');
-export const UPLOADS_DIR = join(CLAW_HOME, 'uploads');
-export const MIGRATION_MARKER = join(CLAW_HOME, '.migrated-v1');
-export const SKILLS_DIR = join(CLAW_HOME, 'skills');
-export const SKILLS_REF_DIR = join(CLAW_HOME, 'skills_ref');
+export const JAW_HOME = join(os.homedir(), '.cli-jaw');
+export const PROMPTS_DIR = join(JAW_HOME, 'prompts');
+export const DB_PATH = join(JAW_HOME, 'jaw.db');
+export const SETTINGS_PATH = join(JAW_HOME, 'settings.json');
+export const HEARTBEAT_JOBS_PATH = join(JAW_HOME, 'heartbeat.json');
+export const UPLOADS_DIR = join(JAW_HOME, 'uploads');
+export const MIGRATION_MARKER = join(JAW_HOME, '.migrated-v1');
+export const SKILLS_DIR = join(JAW_HOME, 'skills');
+export const SKILLS_REF_DIR = join(JAW_HOME, 'skills_ref');

@@ -46,1 +46,1 @@
-/** Locate the cli-claw package root (for bundled skills_ref/) */
+/** Locate the cli-jaw package root (for bundled skills_ref/) */

@@ -65,4 +65,4 @@
-    const legacyDb = join(projectDir, 'claw.db');
+    const legacyDb = join(projectDir, 'jaw.db');
     if (fs.existsSync(legacySettings) && !fs.existsSync(SETTINGS_PATH)) {
         fs.copyFileSync(legacySettings, SETTINGS_PATH);
-        console.log('[migrate] settings.json → ~/.cli-claw/');
+        console.log('[migrate] settings.json → ~/.cli-jaw/');
     }
     if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
         fs.copyFileSync(legacyDb, DB_PATH);
-        console.log('[migrate] claw.db → ~/.cli-claw/');
+        console.log('[migrate] jaw.db → ~/.cli-jaw/');
     }
```

**⚠️ CLAW_HOME → JAW_HOME 변경 시 모든 import 수정 필요:**

영향받는 파일 (import 경로 변경):
- `src/prompt/builder.ts` (line 4)
- `src/memory/memory.ts` (line 4)
- `src/memory/worklog.ts` (line 6)
- `src/browser/actions.ts` (line 2)
- `src/browser/connection.ts` (line 1)
- `server.ts` (line 33)

```diff
--- 모든 import 파일
-import { CLAW_HOME, ... } from '../core/config.js';
+import { JAW_HOME, ... } from '../core/config.js';
```

그리고 사용처도 전부:
```diff
-join(CLAW_HOME, 'xxx')
+join(JAW_HOME, 'xxx')
```

---

## Phase 2: 에이전트 스폰 로그 (`src/agent/spawn.ts`)

21곳 — 모든 `[claw:` 로그 prefix 변경

```diff
--- src/agent/spawn.ts
+++ src/agent/spawn.ts
@@ -31
-    console.log('[claw:fallback] state reset');
+    console.log('[jaw:fallback] state reset');
@@ -42
-    console.log(`[claw:kill] reason=${reason}`);
+    console.log(`[jaw:kill] reason=${reason}`);
@@ -54
-        console.log(`[claw:killAll] killing ${id}, reason=${reason}`);
+        console.log(`[jaw:killAll] killing ${id}, reason=${reason}`);
@@ -201
-        console.log('[claw] Agent already running, skipping');
+        console.log('[jaw] Agent already running, skipping');
@@ -217
-                console.log(`[claw:fallback] ${cli} retries exhausted → direct ${st.fallbackCli}`);
+                console.log(`[jaw:fallback] ${cli} retries exhausted → direct ${st.fallbackCli}`);
@@ -244
-        console.log(`[claw:resume] ${cli} session=${resumeSessionId.slice(0, 12)}...`);
+        console.log(`[jaw:resume] ${cli} session=${resumeSessionId.slice(0, 12)}...`);
@@ -252
-        console.log(`[claw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
+        console.log(`[jaw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
@@ -254
-        console.log(`[claw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
+        console.log(`[jaw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
@@ -260
-        const tmpSysFile = join(os.tmpdir(), `claw-gemini-sys-${agentLabel}.md`);
+        const tmpSysFile = join(os.tmpdir(), `jaw-gemini-sys-${agentLabel}.md`);
@@ -286
-        } catch (e: unknown) { console.warn('[claw:copilot] config.json sync failed:', (e as Error).message); }
+        } catch (e: unknown) { console.warn('[jaw:copilot] config.json sync failed:', (e as Error).message); }
@@ -401
-                console.log(`[claw:fallback] ${cli} recovered — clearing fallback state`);
+                console.log(`[jaw:fallback] ${cli} recovered — clearing fallback state`);
@@ -439
-                            console.log(`[claw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
+                            console.log(`[jaw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
@@ -442
-                            console.log(`[claw:fallback] ${cli} → ${fallbackCli}, ${FALLBACK_MAX_RETRIES} retries queued`);
+                            console.log(`[jaw:fallback] ${cli} → ${fallbackCli}, ${FALLBACK_MAX_RETRIES} retries queued`);
@@ -513
-                    console.log(`[claw:event:${agentLabel}] ${cli} type=${event.type}`);
+                    console.log(`[jaw:event:${agentLabel}] ${cli} type=${event.type}`);
@@ -514
-                    console.log(`[claw:raw:${agentLabel}] ${line.slice(0, 300)}`);
+                    console.log(`[jaw:raw:${agentLabel}] ${line.slice(0, 300)}`);
@@ -525
-        console.error(`[claw:stderr:${agentLabel}] ${text}`);
+        console.error(`[jaw:stderr:${agentLabel}] ${text}`);
@@ -538
-            console.log(`[claw:session] saved ${cli} session=${ctx.sessionId.slice(0, 12)}...`);
+            console.log(`[jaw:session] saved ${cli} session=${ctx.sessionId.slice(0, 12)}...`);
@@ -543
-            console.log(`[claw:fallback] ${cli} recovered — clearing fallback state`);
+            console.log(`[jaw:fallback] ${cli} recovered — clearing fallback state`);
@@ -594
-                        console.log(`[claw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
+                        console.log(`[jaw:fallback] ${cli} retry consumed, ${st.retriesLeft} left`);
@@ -597
-                        console.log(`[claw:fallback] ${cli} → ${fallbackCli}, ${FALLBACK_MAX_RETRIES} retries queued`);
+                        console.log(`[jaw:fallback] ${cli} → ${fallbackCli}, ${FALLBACK_MAX_RETRIES} retries queued`);
@@ -612
-        console.log(`[claw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);
+        console.log(`[jaw:${agentLabel}] exited code=${code}, text=${ctx.fullText.length} chars`);
```

---

## Phase 3: 프롬프트 빌더 (`src/prompt/builder.ts`)

약 30곳 — 에이전트 프롬프트 문자열 전체

```diff
--- src/prompt/builder.ts
+++ src/prompt/builder.ts
@@ -4
-import { settings, CLAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile } from '../core/config.js';
+import { settings, JAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile } from '../core/config.js';
@@ -12
-/** Read all active skills from ~/.cli-claw/skills/ */
+/** Read all active skills from ~/.cli-jaw/skills/ */
@@ -87,3 +87,3 @@
-const A1_CONTENT = `# Claw Agent
+const A1_CONTENT = `# Jaw Agent
 
-You are Claw Agent, a system-level AI assistant.
+You are Jaw Agent, a system-level AI assistant.

## Browser Control 섹션 (line 102-125)
 모든 `cli-claw` → cli-jaw 치환 (약 10곳)

## Telegram 섹션 (line 134-135)
-TOKEN=$(jq -r '.telegram.token' ~/.cli-claw/settings.json)
-CHAT_ID=$(jq -r '.telegram.allowedChatIds[-1]' ~/.cli-claw/settings.json)
+TOKEN=$(jq -r '.telegram.token' ~/.cli-jaw/settings.json)
+CHAT_ID=$(jq -r '.telegram.allowedChatIds[-1]' ~/.cli-jaw/settings.json)

## Memory 섹션 (line 149-156)
 모든 `~/.cli-claw/` → `~/.cli-jaw/`
 모든 `cli-claw memory` → `cli-jaw memory`

## Heartbeat 섹션 (line 167)
-Recurring tasks via \`~/.cli-claw/heartbeat.json\`
+Recurring tasks via \`~/.cli-jaw/heartbeat.json\`

## Dev Skills 섹션 (line 183-189)
 모든 `~/.cli-claw/skills/` → `~/.cli-jaw/skills/`
 모든 `cli-claw skill` → `cli-jaw skill`

## Identity 섹션 (line 197-198)
-- Name: Claw
-- Emoji: 🦞
+- Name: Jaw
+- Emoji: 🦈

## 동적 빌드 부분 (line 302-464)
@@ -302
-        const memPath = join(CLAW_HOME, 'memory', 'MEMORY.md');
+        const memPath = join(JAW_HOME, 'memory', 'MEMORY.md');
@@ -307
-                    ? coreMem.slice(0, 1500) + '\n...(use `cli-claw memory read MEMORY.md` for full)'
+                    ? coreMem.slice(0, 1500) + '\n...(use `cli-jaw memory read MEMORY.md` for full)'
@@ -361
-            prompt += '\nTo modify: edit ~/.cli-claw/heartbeat.json (auto-reloads on save)';
+            prompt += '\nTo modify: edit ~/.cli-jaw/heartbeat.json (auto-reloads on save)';
@@ -381
-                prompt += '**Development tasks**: Before writing code, ALWAYS read `~/.cli-claw/skills/dev/SKILL.md`...';
+                prompt += '**Development tasks**: Before writing code, ALWAYS read `~/.cli-jaw/skills/dev/SKILL.md`...';
@@ -392-393
-                prompt += '**How to use**: read `~/.cli-claw/skills_ref/<name>/SKILL.md`...';
-                prompt += '**To activate permanently**: `cli-claw skill install <name>`\n\n';
+                prompt += '**How to use**: read `~/.cli-jaw/skills_ref/<name>/SKILL.md`...';
+                prompt += '**To activate permanently**: `cli-jaw skill install <name>`\n\n';
@@ -437-440
-    prompt += `For web tasks, always use \`cli-claw browser\` commands.\n`;
-    prompt += `Start: \`cli-claw browser start\`, Snapshot: \`cli-claw browser snapshot\`\n`;
-    prompt += `Click: \`cli-claw browser click <ref>\`, Type: \`cli-claw browser type <ref> "text"\`\n`;
+    prompt += `For web tasks, always use \`cli-jaw browser\` commands.\n`;
+    prompt += `Start: \`cli-jaw browser start\`, Snapshot: \`cli-jaw browser snapshot\`\n`;
+    prompt += `Click: \`cli-jaw browser click <ref>\`, Type: \`cli-jaw browser type <ref> "text"\`\n`;
@@ -464
-    prompt += `Long-term memory: use \`cli-claw memory search/read/save\` commands.\n`;
+    prompt += `Long-term memory: use \`cli-jaw memory search/read/save\` commands.\n`;
```

---

## Phase 4: 기타 src/ 파일들

### `src/agent/events.ts` (1곳)
```diff
@@ -251
-// ─── ACP session/update → cli-claw internal event ────────────────
+// ─── ACP session/update → cli-jaw internal event ────────────────
```

### `src/cli/acp-client.ts` (1곳)
```diff
@@ -271
-            clientInfo: { name: 'cli-claw', version: '0.1.0' },
+            clientInfo: { name: 'cli-jaw', version: '0.1.0' },
```

### `src/cli/handlers.ts` (2곳)
```diff
@@ -118
-            `🦞 cli-claw v${ctx.version || 'unknown'}`,
+            `🦈 cli-jaw v${ctx.version || 'unknown'}`,
@@ -275
-    const lines = [`cli-claw v${ctx.version || 'unknown'}`];
+    const lines = [`cli-jaw v${ctx.version || 'unknown'}`];
```

### `src/orchestrator/pipeline.ts` (4곳)
```diff
@@ -58
-            console.log(`[claw:phase-skip] ${st.agent} (${role}): skipping to phase ${startPhase}`);
+            console.log(`[jaw:phase-skip] ${st.agent} (${role}): skipping to phase ${startPhase}`);
@@ -236
-        console.log(`[claw:triage] direct response (no orchestration needed)`);
+        console.log(`[jaw:triage] direct response (no orchestration needed)`);
@@ -241
-            console.log(`[claw:triage] agent chose to dispatch (${lateSubtasks.length} subtasks)`);
+            console.log(`[jaw:triage] agent chose to dispatch (${lateSubtasks.length} subtasks)`);
@@ -315
-        console.log('[claw:triage] planning agent chose direct response');
+        console.log('[jaw:triage] planning agent chose direct response');
```

### `src/memory/memory.ts` (3곳)
```diff
@@ -4
-import { CLAW_HOME } from '../core/config.js';
+import { JAW_HOME } from '../core/config.js';
@@ -9
-export const MEMORY_DIR = join(CLAW_HOME, 'memory');
+export const MEMORY_DIR = join(JAW_HOME, 'memory');
@@ -127
-        ? content.slice(0, maxChars) + '\n...(use `cli-claw memory read MEMORY.md` for full content)'
+        ? content.slice(0, maxChars) + '\n...(use `cli-jaw memory read MEMORY.md` for full content)'
```

### `src/memory/worklog.ts` (2곳)
```diff
@@ -6
-import { CLAW_HOME } from '../core/config.js';
+import { JAW_HOME } from '../core/config.js';
@@ -21
-export const WORKLOG_DIR = join(CLAW_HOME, 'worklogs');
+export const WORKLOG_DIR = join(JAW_HOME, 'worklogs');
```

### `src/browser/actions.ts` (2곳)
```diff
@@ -2
-import { CLAW_HOME } from '../core/config.js';
+import { JAW_HOME } from '../core/config.js';
@@ -6
-const SCREENSHOTS_DIR = join(CLAW_HOME, 'screenshots');
+const SCREENSHOTS_DIR = join(JAW_HOME, 'screenshots');
```

### `src/browser/connection.ts` (2곳)
```diff
@@ -1
-import { CLAW_HOME } from '../core/config.js';
+import { JAW_HOME } from '../core/config.js';
@@ -7
-const PROFILE_DIR = join(CLAW_HOME, 'browser-profile');
+const PROFILE_DIR = join(JAW_HOME, 'browser-profile');
```

---

## Phase 5: server.ts (11곳)

```diff
--- server.ts
+++ server.ts
@@ -1
-// ─── CLI-Claw Server (glue + routes) ─────────────────
+// ─── cli-jaw Server (glue + routes) ─────────────────
@@ -33
-    CLAW_HOME, PROMPTS_DIR, DB_PATH, UPLOADS_DIR,
+    JAW_HOME, PROMPTS_DIR, DB_PATH, UPLOADS_DIR,
@@ -268
-        console.log(`[claw:session] invalidated — CLI changed ${prevCli} → ${settings.cli}`);
+        console.log(`[jaw:session] invalidated — CLI changed ${prevCli} → ${settings.cli}`);
@@ -604
-        const mcpPath = join(CLAW_HOME, 'mcp.json');
+        const mcpPath = join(JAW_HOME, 'mcp.json');
@@ -751,756,764,772,777
-app.get('/api/claw-memory/search', ...
-app.get('/api/claw-memory/read', ...
-app.post('/api/claw-memory/save', ...
-app.get('/api/claw-memory/list', ...
-app.post('/api/claw-memory/init', ...
+app.get('/api/jaw-memory/search', ...
+app.get('/api/jaw-memory/read', ...
+app.post('/api/jaw-memory/save', ...
+app.get('/api/jaw-memory/list', ...
+app.post('/api/jaw-memory/init', ...
@@ -826
-    log.info(`\n  🦞 Claw Agent — http://localhost:${PORT}\n`);
+    log.info(`\n  🦈 Jaw Agent — http://localhost:${PORT}\n`);
@@ -839
-            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-claw/backups/skills-conflicts`);
+            console.log(`  Skills: moved ${moved.length} conflict path(s) to ~/.cli-jaw/backups/skills-conflicts`);
@@ -841
-        console.log(`  MCP:    ~/.cli-claw/mcp.json`);
+        console.log(`  MCP:    ~/.cli-jaw/mcp.json`);
```

---

## Phase 6: lib/ 파일들

### `lib/mcp-sync.ts` (~20곳)
```diff
@@ -4
-* Source of truth: ~/.cli-claw/mcp.json
+* Source of truth: ~/.cli-jaw/mcp.json
@@ -16,17
-const CLAW_HOME = join(os.homedir(), '.cli-claw');
-const MCP_PATH = join(CLAW_HOME, 'mcp.json');
+const JAW_HOME = join(os.homedir(), '.cli-jaw');
+const MCP_PATH = join(JAW_HOME, 'mcp.json');
@@ -30
-    fs.mkdirSync(CLAW_HOME, { recursive: true });
+    fs.mkdirSync(JAW_HOME, { recursive: true });

## 나머지 CLAW_HOME → JAW_HOME (line 217, 279, 506, 507)
## 주석 내 ~/.cli-claw → ~/.cli-jaw (line 211, 222, 244, 248, 501, 573)

## ⚠️ 유지: OPENCLAW_ACTIVE (line 522, 594, 602, 606) — 외부 프로젝트명
```

### `lib/upload.ts` (1곳)
```diff
@@ -11
-* Save a buffer to ~/.cli-claw/uploads/ with a timestamped filename.
+* Save a buffer to ~/.cli-jaw/uploads/ with a timestamped filename.
```

---

## Phase 7: CLI 진입점 + 커맨드

### `bin/cli-claw.ts` → 파일명 리네임 + 내용 변경
```bash
git mv bin/cli-claw.ts bin/cli-jaw.ts
```

```diff
--- bin/cli-claw.ts → bin/cli-jaw.ts
+++ bin/cli-jaw.ts
@@ -3
-* cli-claw — Phase 9.1
+* cli-jaw — Phase 9.1
@@ -23
-  🦞 cli-claw v${pkg.version}
+  🦈 cli-jaw v${pkg.version}
@@ -25
-  Usage:  cli-claw <command> [options]
+  Usage:  cli-jaw <command> [options]
@@ -43-46
-    cli-claw serve --port 3457
-    cli-claw init
-    cli-claw doctor --json
-    cli-claw chat --raw
+    cli-jaw serve --port 3457
+    cli-jaw init
+    cli-jaw doctor --json
+    cli-jaw chat --raw
@@ -86
-        console.log(`cli-claw v${pkg.version}`);
+        console.log(`cli-jaw v${pkg.version}`);
```

### `bin/commands/browser.ts` (6곳)
```diff
@@ -2  cli-claw browser → cli-jaw browser
@@ -13 CLAW_HOME → JAW_HOME, '.cli-claw' → '.cli-jaw'
@@ -77  cli-claw → cli-jaw
@@ -106 cli-claw → cli-jaw
@@ -118 cli-claw → cli-jaw
@@ -192,199 CLAW_HOME → JAW_HOME
@@ -210 cli-claw → cli-jaw
```

### `bin/commands/chat.ts` (5곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -48 cli-claw serve → cli-jaw serve
@@ -116,117 /api/claw-memory → /api/jaw-memory
@@ -128 cli-claw → cli-jaw
@@ -190 cli-claw → cli-jaw
```

### `bin/commands/doctor.ts` (8곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -11 '.cli-claw' → '.cli-jaw'
@@ -12 CLAW_HOME → JAW_HOME
@@ -13 claw.db → jaw.db
@@ -14 CLAW_HOME → JAW_HOME
@@ -40 🦞 cli-claw → 🦈 cli-jaw
@@ -44,45 CLAW_HOME → JAW_HOME
@@ -51 cli-claw init → cli-jaw init
@@ -57 claw.db → jaw.db
@@ -93 CLAW_HOME → JAW_HOME
```

### `bin/commands/employee.ts` (3곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -4  cli-claw → cli-jaw
@@ -23 cli-claw → cli-jaw
```

### `bin/commands/init.ts` (8곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -11 '.cli-claw' → '.cli-jaw'
@@ -12 CLAW_HOME → JAW_HOME
@@ -30 CLAW_HOME → JAW_HOME
@@ -42 🦞 cli-claw → 🦈 cli-jaw
@@ -73 CLAW_HOME → JAW_HOME
@@ -92 CLAW_HOME → JAW_HOME
@@ -115,116 cli-claw → cli-jaw
```

### `bin/commands/mcp.ts` (15곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -6-9  cli-claw → cli-jaw (4곳)
@@ -29 '.cli-claw' → '.cli-jaw', CLAW_HOME → JAW_HOME
@@ -47 CLAW_HOME → JAW_HOME
@@ -106-110 cli-claw → cli-jaw (5곳)
@@ -159 ~/.cli-claw → ~/.cli-jaw
@@ -173 CLAW_HOME → JAW_HOME
@@ -211-213 cli-claw → cli-jaw (3곳)
@@ -219 cli-claw → cli-jaw
```

### `bin/commands/memory.ts` (8곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -13 /api/claw-memory → /api/jaw-memory
@@ -25 cli-claw → cli-jaw
@@ -32 cli-claw → cli-jaw
@@ -47 cli-claw → cli-jaw
@@ -55 cli-claw → cli-jaw
@@ -66 ~/.cli-claw → ~/.cli-jaw
@@ -71 cli-claw → cli-jaw
```

### `bin/commands/reset.ts` (4곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -4  cli-claw → cli-jaw
@@ -23 cli-claw → cli-jaw
@@ -63 cli-claw serve → cli-jaw serve
```

### `bin/commands/serve.ts` (1곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -33 🦞 cli-claw → 🦈 cli-jaw
```

### `bin/commands/skill.ts` (14곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -6-9  cli-claw → cli-jaw (4곳)
@@ -16 '.cli-claw' → '.cli-jaw', CLAW_HOME → JAW_HOME
@@ -17 CLAW_HOME → JAW_HOME
@@ -54 CLAW_HOME → JAW_HOME
@@ -98-101 cli-claw → cli-jaw (4곳)
@@ -137 ~/.cli-claw → ~/.cli-jaw (2곳)
@@ -144 cli-claw → cli-jaw
@@ -159 cli-claw → cli-jaw
@@ -183-186 cli-claw → cli-jaw (4곳)
@@ -215 CLAW_HOME → JAW_HOME
```

### `bin/commands/status.ts` (2곳)
```diff
@@ -2  cli-claw → cli-jaw
@@ -26 🦞 → 🦈
```

### `bin/postinstall.ts` (~30곳)
```diff
@@ -7-12  ~/.cli-claw → ~/.cli-jaw (6곳)
@@ -24 '.cli-claw' → '.cli-jaw'  (clawHome → jawHome)
@@ -29,37,46,49,56  [claw:init] → [jaw:init] (모든 로그)
@@ -60-63  ~/.cli-claw → ~/.cli-jaw, clawHome → jawHome
@@ -81-212  [claw:init] → [jaw:init] (나머지 모든 로그, ~20곳)
@@ -131 clawHome → jawHome
@@ -140  ~/.cli-claw → ~/.cli-jaw
@@ -191 cli-claw browser → cli-jaw browser
```

---

## Phase 8: `types/global.d.ts`

```diff
@@ -1
-// Global type declarations for cli-claw-ts
+// Global type declarations for cli-jaw
@@ -7
-export interface CliClawConfig {
+export interface CliJawConfig {
```

---

## Phase 9: `package.json`

```diff
--- package.json
+++ package.json
@@ -2
-  "name": "cli-claw-ts",
+  "name": "cli-jaw",
@@ -5-7
-  "bin": {
-    "cli-claw": "dist/bin/cli-claw.js"
-  },
+  "bin": {
+    "cli-jaw": "dist/bin/cli-jaw.js",
+    "jaw": "dist/bin/cli-jaw.js"
+  },
```

> 💡 `jaw`는 `cli-jaw`의 단축 alias — 같은 JS 파일을 가리킴

그 후:
```bash
npm install  # package-lock.json 자동 갱신
```

---

## Phase 10: 테스트 파일 (4개)

### `tests/integration/cli-basic.test.ts`
```diff
@@ -2
-* CLI Basic Tests — bin/cli-claw.js 기본 동작 확인
+* CLI Basic Tests — bin/cli-jaw.js 기본 동작 확인
@@ -11
-const CLI = join(__dirname, '../../bin/cli-claw.ts');
+const CLI = join(__dirname, '../../bin/cli-jaw.ts');
@@ -28
-    assert.ok(out.includes('cli-claw') || out.includes('Commands') || out.includes('Usage'));
+    assert.ok(out.includes('cli-jaw') || out.includes('Commands') || out.includes('Usage'));
```

### `tests/integration/route-registration.test.ts`
```diff
@@ -45-47
-    'GET /api/claw-memory/search', 'GET /api/claw-memory/read',
-    'POST /api/claw-memory/save', 'GET /api/claw-memory/list',
-    'POST /api/claw-memory/init',
+    'GET /api/jaw-memory/search', 'GET /api/jaw-memory/read',
+    'POST /api/jaw-memory/save', 'GET /api/jaw-memory/list',
+    'POST /api/jaw-memory/init',
```

### `tests/unit/employee-prompt.test.ts`
```diff
@@ -36
-    assert.ok(prompt.includes('cli-claw browser'));
+    assert.ok(prompt.includes('cli-jaw browser'));
```

### `tests/unit/worklog.test.ts`
```diff
@@ -5-6
-// Note: createWorklog, appendToWorklog, updateMatrix write to ~/.cli-claw/worklogs/
-// which requires CLAW_HOME override.
+// Note: createWorklog, appendToWorklog, updateMatrix write to ~/.cli-jaw/worklogs/
+// which requires JAW_HOME override.
```

---

## Phase 11: 문서 파일

### `AGENTS.md`
```diff
@@ -1
-# CLI-Claw
+# cli-jaw
@@ -33
-tags: [cli-claw, ...]
+tags: [cli-jaw, ...]
```

### `TESTS.md`
```diff
@@ -1
-# 🧪 CLI-CLAW Tests
+# 🧪 cli-jaw Tests
```

### `docs/ARCHITECTURE.md`
```diff
@@ -1
-# 🏗️ CLI-CLAW Architecture
+# 🏗️ cli-jaw Architecture
@@ -88
-| `memory.ts` | config | CLAW_HOME only, independent |
+| `memory.ts` | config | JAW_HOME only, independent |
@@ -112
-| `config.ts` | ~177 | CLAW_HOME, settings, CLI detection |
+| `config.ts` | ~177 | JAW_HOME, settings, CLI detection |
@@ -160
-| `cli-claw.ts` | — | 11 subcommand routing |
+| `cli-jaw.ts` | — | 11 subcommand routing |
@@ -241
-## Runtime Data (`~/.cli-claw/`)
+## Runtime Data (`~/.cli-jaw/`)
@@ -245
-| `claw.db` | SQLite DB (sessions, messages) |
+| `jaw.db` | SQLite DB (sessions, messages) |
@@ -353
-| Memory | `GET/POST /api/memory`, `GET /api/claw-memory/search` |
+| Memory | `GET/POST /api/memory`, `GET /api/jaw-memory/search` |
```

### `public/locales/en.json`
```diff
-    "tg.connected": "🦞 Claw Agent connected! Send a message and the AI agent will respond.",
+    "tg.connected": "🦈 Jaw Agent connected! Send a message and the AI agent will respond.",
```

### `public/locales/ko.json`
```diff
-    "tg.connected": "🦞 Claw Agent 연결됨! 메시지를 보내면 AI 에이전트가 응답합니다.",
+    "tg.connected": "🦈 Jaw Agent 연결됨! 메시지를 보내면 AI 에이전트가 응답합니다.",
```

### `README.md`, `README.ko.md`, `README.zh-CN.md`
각각 ~18곳씩 일괄 치환:
```bash
# 각 README에서
sed -i '' 's/cli-claw/cli-jaw/g; s/CLI-Claw/cli-jaw/g; s/CLI-CLAW/CLI-JAW/g; s/Claw Agent/Jaw Agent/g; s/🦞/🦈/g' README.md README.ko.md README.zh-CN.md
```

---

## Phase 12: skills_ref/ SKILL.md 파일들

### 변경 대상 (cli-claw 직접 참조하는 것만)
| 파일 | 변경 수 |
|------|---------|
| `skills_ref/browser/SKILL.md` | ~40곳 |
| `skills_ref/memory/SKILL.md` | ~20곳 |
| `skills_ref/vision-click/SKILL.md` | ~15곳 |
| `skills_ref/dev/SKILL.md` | 4곳 |
| `skills_ref/dev-backend/SKILL.md` | 3곳 |
| `skills_ref/dev-data/SKILL.md` | 3곳 |
| `skills_ref/screen-capture/SKILL.md` | 2곳 |
| `skills_ref/telegram-send/SKILL.md` | 3곳 |
| `skills_ref/registry.json` | 2곳 |

모두 동일 패턴:
```bash
sed -i '' 's/cli-claw/cli-jaw/g; s/~\/.cli-claw/~\/.cli-jaw/g' <file>
```

### 변경하지 않는 skills_ref
- `1password/`, `apple-notes/`, `apple-reminders/` — OpenClaw/Clawdbot 참조만 있음

---

## Phase 13: 아스키 아트 배너 🦈

`bin/cli-jaw.ts`의 `printHelp()` 함수에 적용:

```typescript
function printHelp() {
    const c = {
        cyan: '\x1b[36m',
        blue: '\x1b[34m',
        dim: '\x1b[2m',
        bold: '\x1b[1m',
        reset: '\x1b[0m',
    };
    console.log(`
${c.cyan}     _____ _      _____    _                 
    / ____| |    |_   _|  | |                
   | |    | |      | |    | | __ ___      __ 
   | |    | |      | |_   | |/ _\` \\ \\ /\\ / / 
   | |____| |____ _| |_|  | | (_| |\\ V  V /  
    \\_____|______|_____|  _/ |\\__,_| \\_/\\_/   
                         |__/                 ${c.reset}
${c.dim}   ───────────────────────────────────────${c.reset}
${c.bold}   🦈 v${pkg.version}${c.reset}  ${c.dim}AI Agent Orchestration Platform${c.reset}

  ${c.bold}Usage:${c.reset}  cli-jaw <command> [options]

  ${c.cyan}Commands:${c.reset}
    serve      서버 시작 (포그라운드)
    init       초기 설정 마법사
    doctor     설치/설정 진단
    chat       터미널 채팅 (REPL)
    employee   직원 관리 (reset)
    reset      전체 초기화
    mcp        MCP 서버 관리
    skill      스킬 관리
    status     서버 상태 확인
    browser    브라우저 제어
    memory     영구 메모리 관리

  ${c.dim}Options:${c.reset}
    --help     도움말 표시
    --version  버전 표시

  ${c.dim}Examples:
    cli-jaw serve --port 3457
    cli-jaw doctor --json
    cli-jaw chat --raw${c.reset}
`);
}
```

### `bin/commands/serve.ts` 배너
```diff
-console.log(`\n  🦞 cli-claw serve — port ${values.port}\n`);
+console.log(`\n  🦈 cli-jaw serve — port ${values.port}\n`);
```

### `bin/commands/doctor.ts` 배너
```diff
-console.log(!values.json ? '\n  🦞 cli-claw doctor\n' : '');
+console.log(!values.json ? '\n  🦈 cli-jaw doctor\n' : '');
```

---

## Phase 14: 런타임 마이그레이션 (호환성)

`bin/postinstall.ts`에 마이그레이션 로직 추가 (최상단):

```typescript
// ─── Legacy migration: ~/.cli-claw → ~/.cli-jaw ───
const legacyHome = path.join(home, '.cli-claw');
const jawHome = path.join(home, '.cli-jaw');

if (fs.existsSync(legacyHome) && !fs.existsSync(jawHome)) {
    console.log(`[jaw:init] migrating ~/.cli-claw → ~/.cli-jaw ...`);
    fs.renameSync(legacyHome, jawHome);
    console.log(`[jaw:init] ✅ migration complete`);
} else if (fs.existsSync(legacyHome) && fs.existsSync(jawHome)) {
    console.log(`[jaw:init] ⚠️ both ~/.cli-claw and ~/.cli-jaw exist — using ~/.cli-jaw`);
}
```

`src/core/config.ts`의 `runMigration()`에도 추가:
```typescript
// Legacy claw.db → jaw.db rename (in-place)
const legacyDb = join(JAW_HOME, 'claw.db');
if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
    fs.renameSync(legacyDb, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
        const src = legacyDb + ext;
        const dst = DB_PATH + ext;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    console.log('[migrate] claw.db → jaw.db');
}
```

---

## Phase 15: 검증

```bash
# 1. 빌드
cd /Users/junny/Documents/BlogProject/cli-claw-ts
npx tsc --noEmit

# 2. 테스트
npm test

# 3. 잔여 참조 확인 (유지 대상 제외)
grep -rn "cli-claw\|CLAW_HOME\|claw\.db\|🦞" \
  --include="*.ts" --include="*.json" --include="*.md" \
  . | grep -v node_modules | grep -v dist | grep -v devlog | \
  grep -v "OpenClaw\|OPENCLAW\|Clawdbot\|CLAWDBOT\|Cliclaw" | \
  grep -v package-lock

# 기대 결과: 0건
```

---

## 작업 순서 요약

| 순서 | Phase | 파일 수 | 변경 수 |
|------|-------|---------|---------|
| 1 | config.ts (핵심) | 1 | ~15 |
| 2 | src/ import 수정 | 8 | ~20 |
| 3 | spawn.ts 로그 | 1 | ~21 |
| 4 | prompt/builder.ts | 1 | ~30 |
| 5 | 기타 src/ | 5 | ~12 |
| 6 | server.ts | 1 | ~11 |
| 7 | lib/ | 2 | ~22 |
| 8 | CLI 진입점+커맨드 | 13 | ~100 |
| 9 | types | 1 | 2 |
| 10 | package.json | 1 | 2 |
| 11 | 테스트 | 4 | ~10 |
| 12 | 문서 | 8 | ~60 |
| 13 | skills_ref | 9 | ~90 |
| 14 | 아스키 아트 | 3 | 신규 |
| 15 | 마이그레이션 | 2 | 신규 |
| 16 | 검증 | — | — |
| **총합** | | **~60개** | **~400곳** |
