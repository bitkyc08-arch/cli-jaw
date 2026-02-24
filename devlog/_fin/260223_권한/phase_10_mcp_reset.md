# (fin) Phase 10 — MCP Reset + 코드 중복 제거

## 개요

MCP 관리 명령어의 커버리지 갭과 코드 중복을 해결하는 phase.

**진단 요약:**

| 문제                        | 심각도   | 영향                                           |
| --------------------------- | -------- | ---------------------------------------------- |
| `syncAll()` 코드 중복       | 🔴 High   | CLI는 2개 타겟만 sync, lib은 4개 — 동작 불일치 |
| `mcp reset` CLI 명령어 없음 | 🟡 Medium | `skill reset`과 대칭성 깨짐, 복구 수단 부재    |
| `/api/mcp/reset` REST 없음  | 🟡 Medium | Web UI MCP 관리 화면 불완전                    |

---

## 1. 코드 중복 제거: `syncAll()` → `syncToAll()` 통합

### 문제 분석

`bin/commands/mcp.js`의 `syncAll()` (L92-150)이 `lib/mcp-sync.js`의 `syncToAll()` (L135-192)과 거의 동일한 로직을 인라인으로 보유:

```
bin/commands/mcp.js                     lib/mcp-sync.js
┌───────────────────────┐               ┌───────────────────────┐
│ syncAll(config)       │               │ syncToAll(config, wd) │
│                       │               │                       │
│ ① Claude: 인라인 JSON │  ← 중복 →    │ ① Claude: toClaudeMcp │
│ ② Codex:  인라인 TOML │  ← 중복 →    │ ② Codex:  toCodexToml │
│ ③ Gemini: ❌ 없음     │               │ ③ Gemini: ✅ 지원     │
│ ④ OpenCode: ❌ 없음   │               │ ④ OpenCode: ✅ 지원   │
└───────────────────────┘               └───────────────────────┘
```

**상세 비교:**

| 기능             | `mcp.js` `syncAll()`          | `mcp-sync.js` `syncToAll()`            |
| ---------------- | ----------------------------- | -------------------------------------- |
| Claude sync      | ✅ 인라인 JSON 생성            | ✅ `toClaudeMcp()` 헬퍼 호출            |
| Codex TOML patch | ✅ 인라인 TOML 생성            | ✅ `toCodexToml()` + `patchCodexToml()` |
| Gemini sync      | ❌ **빠짐**                    | ✅ `patchJsonFile()`                    |
| OpenCode sync    | ❌ **빠짐**                    | ✅ `toOpenCodeMcp()`                    |
| workingDir       | ⚠️ settings.json에서 직접 읽음 | ✅ 인자로 전달                          |
| 에러 핸들링      | ✅ try/catch                   | ✅ per-target try/catch                 |

> CLI가 `syncAll()`을 쓰면 Gemini/OpenCode에는 sync가 안 됨. **기능 버그**.

### 해결: 인라인 삭제 + import 통합

#### [MODIFY] `bin/commands/mcp.js`

**Before** (L1-44, 92-150 삭제 대상):

```javascript
// ❌ 현재: 자체 helper 함수들 (lib과 중복)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAW_HOME = join(homedir(), '.cli-claw');
const MCP_PATH = join(CLAW_HOME, 'mcp.json');

function loadMcp() { /* ... 중복 ... */ }
function saveMcp(config) { /* ... 중복 ... */ }
function syncAll(config) {
    // 60줄의 인라인 sync 로직 — Claude + Codex만 지원
}
```

**After:**

```javascript
/**
 * cli-claw mcp — Phase 10
 * MCP server management: list, install, sync, reset.
 *
 * Usage:
 *   cli-claw mcp                       # list servers
 *   cli-claw mcp install <pkg>         # install npm/pypi package + add to mcp.json + sync
 *   cli-claw mcp sync                  # sync mcp.json → 4 CLI configs
 *   cli-claw mcp reset                 # reset mcp.json to defaults + re-sync
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── lib/mcp-sync.js에서 통합 import ──────────
import {
    loadUnifiedMcp,
    saveUnifiedMcp,
    syncToAll,
    initMcpConfig,
} from '../../lib/mcp-sync.js';

const CLAW_HOME = join(homedir(), '.cli-claw');

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

// ─── Helpers ─────────────────────────────────

function exec(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 120000 }).trim();
}

/**
 * settings.json에서 workingDir 추출.
 * syncToAll()에 전달하기 위한 용도.
 */
function getWorkingDir() {
    try {
        const settingsPath = join(CLAW_HOME, 'settings.json');
        return JSON.parse(readFileSync(settingsPath, 'utf8')).workingDir || homedir();
    } catch { return homedir(); }
}
```

> `loadMcp()` → `loadUnifiedMcp()`, `saveMcp()` → `saveUnifiedMcp()`, `syncAll()` → `syncToAll()` 교체.

**삭제되는 코드:**
- `loadMcp()` (L31-34) — `loadUnifiedMcp()`로 대체
- `saveMcp()` (L36-39) — `saveUnifiedMcp()`로 대체
- `syncAll()` (L92-150) — 60줄 전체 삭제, `syncToAll(config, getWorkingDir())`로 대체

**호출부 변경:**

```diff
 // install case (L187)
-            syncAll(config);
+            syncToAll(config, getWorkingDir());

 // sync case (L199)
-        syncAll(config);
+        syncToAll(config, getWorkingDir());
```

**효과:**
- 60줄 인라인 코드 삭제
- CLI `mcp sync`가 4개 타겟 전부 동기화 (기존 2개 → 4개, 동작 불일치 버그 수정)
- 단일 소스 원칙(Single Source of Truth) — sync 로직은 `lib/mcp-sync.js`에만 존재

---

## 2. CLI: `cli-claw mcp reset` 서브커맨드 추가

### 설계

`skill reset` 패턴을 그대로 따름:

```
cli-claw mcp reset [--force]

1. 확인 프롬프트 (--force면 스킵)
2. ~/.cli-claw/mcp.json 삭제
3. initMcpConfig(workingDir) 재실행
   → 기존 {workingDir}/.mcp.json에서 import + DEFAULT_MCP_SERVERS merge
4. syncToAll() → 4개 CLI에 재동기화
```

> `fs.unlinkSync(path)`는 파일이 존재하지 않으면 `ENOENT` 에러를 던지므로, `existsSync()` 체크 후 호출.  
> 출처: [Node.js fs.unlink() docs](https://github.com/nodejs/node/blob/main/doc/api/fs.md)

### 구현

#### [MODIFY] `bin/commands/mcp.js` — `reset` case 추가

switch문의 `default` 앞에 추가:

```javascript
case 'reset': {
    const force = process.argv.includes('--force');
    if (!force) {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(r => {
            rl.question(
                `\n  ${c.yellow}⚠️  MCP 설정을 초기화합니다.${c.reset}\n` +
                `  ~/.cli-claw/mcp.json이 재생성되고 4개 CLI에 재동기화됩니다.\n` +
                `  계속하시겠습니까? (y/N): `, r
            );
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') {
            console.log('  취소됨.\n');
            break;
        }
    }

    console.log(`\n  ${c.bold}🔄 MCP 설정 초기화 중...${c.reset}\n`);

    // 1. Delete existing mcp.json
    const mcpPath = join(CLAW_HOME, 'mcp.json');
    if (existsSync(mcpPath)) {
        unlinkSync(mcpPath);
        console.log(`  ${c.dim}✓ deleted ${mcpPath}${c.reset}`);
    }

    // 2. Re-init (import from workingDir/.mcp.json + DEFAULT_MCP_SERVERS merge)
    const workingDir = getWorkingDir();
    const config = initMcpConfig(workingDir);

    // 3. Re-sync to all CLIs
    const results = syncToAll(config, workingDir);

    const count = Object.keys(config.servers || {}).length;
    console.log(`\n  ${c.green}✅ 초기화 완료!${c.reset} (${count}개 서버)`);
    for (const [target, ok] of Object.entries(results)) {
        console.log(`  ${ok ? c.green + '✅' : c.dim + '⏭️'} ${target}${c.reset}`);
    }
    console.log(`  ${c.dim}${mcpPath}${c.reset}\n`);
    break;
}
```

**help 텍스트 업데이트** (list case 하단, L219-220):

```diff
     console.log(`  ${c.dim}cli-claw mcp install <pkg>  — 새 MCP 서버 설치${c.reset}`);
     console.log(`  ${c.dim}cli-claw mcp sync           — 4개 CLI에 동기화${c.reset}`);
+    console.log(`  ${c.dim}cli-claw mcp reset          — 설정 초기화 + 재동기화${c.reset}`);
```

**헤더 주석 업데이트** (L1-9):

```diff
-/**
- * cli-claw mcp — Phase 12.1.3.1
- * MCP server management: list, install, sync.
+/**
+ * cli-claw mcp — Phase 10
+ * MCP server management: list, install, sync, reset.
```

---

## 3. REST API: `POST /api/mcp/reset` 엔드포인트 추가

### 설계

Express `app.post()` 패턴으로 구현. 기존 `/api/mcp/install` 직후에 배치.

> Express route handler 패턴: `app.post(path, handler)` — handler는 `(req, res)` 콜백.  
> 에러 시 `res.status(500).json()` 반환.  
> 출처: [Express.js Routing docs](https://expressjs.com/en/guide/routing.html)

### 구현

#### [MODIFY] `server.js` — MCP 섹션 (L345 뒤)

```javascript
// Reset: delete mcp.json → re-init with defaults → re-sync
app.post('/api/mcp/reset', (req, res) => {
    try {
        const mcpPath = join(CLAW_HOME, 'mcp.json');
        if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);

        const config = initMcpConfig(settings.workingDir);
        const results = syncToAll(config, settings.workingDir);

        res.json({
            ok: true,
            servers: Object.keys(config.servers),
            count: Object.keys(config.servers).length,
            synced: results,
        });
    } catch (e) {
        console.error('[mcp:reset]', e);
        res.status(500).json({ error: e.message });
    }
});
```

### API 응답 예시

```json
// POST /api/mcp/reset → 200 OK
{
    "ok": true,
    "servers": ["context7"],
    "count": 1,
    "synced": {
        "claude": true,
        "codex": true,
        "gemini": true,
        "opencode": false
    }
}
```

```json
// POST /api/mcp/reset → 500 Error
{
    "error": "EACCES: permission denied, unlink '/Users/.../.cli-claw/mcp.json'"
}
```

---

## 4. 변경 흐름도

```
cli-claw mcp reset                POST /api/mcp/reset
        │                                 │
        ▼                                 ▼
┌──────────────────────────────────────────────┐
│  1. existsSync(mcp.json) → unlinkSync()      │
│  2. initMcpConfig(workingDir)                │
│     ├─ loadUnifiedMcp() → { servers: {} }    │
│     ├─ merge DEFAULT_MCP_SERVERS (context7)  │
│     └─ import .mcp.json if exists            │
│  3. saveUnifiedMcp(config)                   │
│  4. syncToAll(config, workingDir)            │
│     ├─ Claude:   .mcp.json (mcpServers)      │
│     ├─ Codex:    config.toml ([mcp_servers]) │
│     ├─ Gemini:   settings.json (mcpServers)  │
│     └─ OpenCode: opencode.json (mcp)         │
└──────────────────────────────────────────────┘
```

---

## 5. 최종 커버리지 매트릭스

### MCP CLI + REST

| 기능      | CLI (`cli-claw mcp`)  | REST (`/api/mcp`)           | 비고                 |
| --------- | --------------------- | --------------------------- | -------------------- |
| list      | ✅ `mcp list`          | ✅ `GET /api/mcp`            |                      |
| update    | —                     | ✅ `PUT /api/mcp`            | CLI는 install로 대체 |
| sync      | ✅ `mcp sync`          | ✅ `POST /api/mcp/sync`      | Phase 10: 2→4 타겟   |
| install   | ✅ `mcp install <pkg>` | ✅ `POST /api/mcp/install`   |                      |
| **reset** | **✅ `mcp reset`**     | **✅ `POST /api/mcp/reset`** | **Phase 10 NEW**     |

### Skills CLI + REST (참고)

| 기능    | CLI (`cli-claw skill`) | REST (`/api/skills`)         |
| ------- | ---------------------- | ---------------------------- |
| list    | ✅ `skill list`         | ✅ `GET /api/skills`          |
| install | ✅ `skill install`      | ✅ `POST /api/skills/enable`  |
| remove  | ✅ `skill remove`       | ✅ `POST /api/skills/disable` |
| info    | ✅ `skill info`         | ✅ `GET /api/skills/:id`      |
| reset   | ✅ `skill reset`        | —                            |

---

## 체크리스트

### 코드 중복 제거
- [x] `bin/commands/mcp.js` — `loadMcp()`, `saveMcp()` 삭제 → `loadUnifiedMcp()`, `saveUnifiedMcp()` import
- [x] `bin/commands/mcp.js` — `syncAll()` 60줄 삭제 → `syncToAll(config, getWorkingDir())` 호출
- [x] `bin/commands/mcp.js` — `getWorkingDir()` 헬퍼 추가

### MCP Reset
- [x] `bin/commands/mcp.js` — `reset` case 구현 (확인 프롬프트 + `--force` 지원)
- [x] `bin/commands/mcp.js` — help 텍스트에 `reset` 안내 추가
- [x] `server.js` — `POST /api/mcp/reset` 엔드포인트 추가

### 검증
- [x] `cli-claw mcp reset` → mcp.json 재생성 + 4개 CLI sync 확인
- [x] `cli-claw mcp sync` → Gemini/OpenCode에도 sync 되는지 확인 (기존 버그 수정)
- [x] `cli-claw mcp list` → reset 안내 표시 확인
- [x] `cli-claw mcp reset --force` → 프롬프트 스킵 + 4개 타겟 sync 확인
