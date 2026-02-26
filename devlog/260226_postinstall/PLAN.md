# 260226 Postinstall 클린 클론 실패 수정

**Date**: 2026-02-26  
**Status**: ✅ 수정 완료  
**Trigger**: 외부 개발자 `git clone` + `npm install` → `Cannot find module 'dist/bin/postinstall.js'`  
**SO**: [#71525751](https://stackoverflow.com/questions/71525751/npm-install-postinstall-cannot-find-module)

---

## npm lifecycle 순서 (검증됨)

```
preinstall → install → postinstall → preprepare → prepare → postprepare
```

> [!CAUTION]
> `prepare`는 `postinstall` **이후** 실행. `"prepare": "tsc"`로는 해결 불가.

---

## 문제 요약

| # | 심각도 | 문제 | 원인 |
|:-:|:---:|------|------|
| ① | 🔴 | 클린 클론 시 postinstall 실패 | `.gitignore`에 `dist/` + `postinstall`이 `dist/bin/postinstall.js` 참조 |
| ② | 🔴 | postinstall → config → registry 4파일 import 체인 | 초기화에 앱 전체 모듈 필요 |
| ③ | 🟠 | Node ≥22 무에러 실패 | `engines` 경고만, 가드 없음 |
| ④ | 🟠 | 무동의 글로벌 설치 8건 (최악 20분) | postinstall에서 직접 execSync |

> [!IMPORTANT]
> `npm i -g cli-jaw` (registry)는 정상 — `files`에 `dist/` 포함.
> **git clone 개발자 경로에서만** 발생.

### 즉시 워크어라운드

```bash
npm install --ignore-scripts && npm run build && node dist/bin/postinstall.js
```

---

## 설계 결정

**Q: 클린 클론 시 초기화 실패하면?**  
**A: `dist/` 없는 경우만 → 자동 빌드 후 실행. 그 외 런타임 에러 → exit 1.**

- `dist/` 미존재 = 유일한 허용 실패 케이스 → inline `tsc` 후 재시도
- `tsc` 자체 실패 = 타입 에러 → **exit 1** (깨진 설치 감지)
- postinstall.js 런타임 에러 = **exit 1** (숨기지 않음)
- mcp-sync 로드 실패 = 개별 단계 스킵이 아닌 **에러 전파**

---

## 실행 계획

### 1. `package.json` + `scripts/postinstall-guard.cjs` — 크로스플랫폼 가드

#### [MODIFY] [package.json](file:///Users/junny/Documents/BlogProject/cli-jaw/package.json#L44)

```diff
-    "postinstall": "node dist/bin/postinstall.js",
+    "postinstall": "node scripts/postinstall-guard.cjs && node dist/bin/postinstall.js",
```

#### [NEW] [postinstall-guard.cjs](file:///Users/junny/Documents/BlogProject/cli-jaw/scripts/postinstall-guard.cjs)

CJS 파일 (TypeScript 빌드 불필요, Windows cmd.exe 호환):
- `dist/bin/postinstall.js` 존재 → `exit 0` → `&& node dist/bin/postinstall.js` 실행
- 미존재 → `npx tsc` 자동 빌드 → 실패 시 `exit 1`
- postinstall.js 런타임 에러 → `exit 1` 전파 (가드가 숨기지 않음)

| 조건 | 결과 |
|------|------|
| `dist/` 존재 (registry/이미 빌드됨) | guard exit 0 → postinstall 직접 실행 |
| `dist/` 없음 (클린 클론) | guard → tsc 빌드 → 성공 시 postinstall 실행 |
| tsc 실패 (타입 에러) | guard exit 1 → **npm install 실패** |
| postinstall.js 런타임 에러 | node exit 1 → **npm install 실패** |

---

### 2. `postinstall.ts` — Node 가드 + JAW_HOME inline

#### [MODIFY] [postinstall.ts](file:///Users/junny/Documents/BlogProject/cli-jaw/bin/postinstall.ts#L1-L25)

```diff
 #!/usr/bin/env node
+
+// ─── Node version guard ─────────────────────────────
+const [major] = process.versions.node.split('.').map(Number);
+if (major! < 22) {
+    console.error(`[jaw:init] ❌ Node.js >= 22 required (current: ${process.version})`);
+    console.error(`[jaw:init]    Install: https://nodejs.org or nvm install 22`);
+    process.exit(1);
+}
+
 import fs from 'fs';
 import path from 'path';
 import os from 'os';
 import { execSync, execFileSync } from 'child_process';
-import { ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';
-import { JAW_HOME } from '../src/core/config.js';
+import { ensureSkillsSymlinks, initMcpConfig, copyDefaultSkills, loadUnifiedMcp, saveUnifiedMcp } from '../lib/mcp-sync.js';  // mcp-sync는 유지 (Step 3에서 config 의존 제거)
+
+// ─── JAW_HOME inline (config.ts → registry.ts 체인 제거) ───
+const JAW_HOME = process.env.CLI_JAW_HOME
+    ? path.resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
+    : path.join(os.homedir(), '.cli-jaw');
 
 const home = os.homedir();
 const jawHome = JAW_HOME;
```

**import 체인 before/after:**

```
BEFORE: postinstall.ts → mcp-sync.ts → config.ts → registry.ts (4파일)
AFTER:  postinstall.ts → mcp-sync.ts (2파일, config/registry 제거)
```

---

### 3. `mcp-sync.ts` — config.ts import 제거

#### [MODIFY] [mcp-sync.ts](file:///Users/junny/Documents/BlogProject/cli-jaw/lib/mcp-sync.ts#L14-L18)

```diff
 import fs from 'fs';
 import os from 'os';
 import { join, dirname, resolve, isAbsolute } from 'path';
 import { fileURLToPath } from 'url';
-import { JAW_HOME } from '../src/core/config.js';
+
+// JAW_HOME: inline 계산 (config.ts → registry.ts 의존 제거)
+const JAW_HOME = process.env.CLI_JAW_HOME
+    ? resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
+    : join(os.homedir(), '.cli-jaw');
 
 const MCP_PATH = join(JAW_HOME, 'mcp.json');
```

나머지 `mcp-sync.ts` 내부의 `JAW_HOME` 사용 — 변경 불필요 (같은 파일 내 상수이므로 그대로 동작).

> [!NOTE]
> `config.ts`의 `JAW_HOME` export는 다른 모듈들이 사용하므로 **삭제하지 않음**. DRY 위반이지만 postinstall 독립성이 우선.

---

## 변경 파일 요약

| 파일 | 변경 | 라인 |
|------|------|:---:|
| [package.json](file:///Users/junny/Documents/BlogProject/cli-jaw/package.json) | postinstall guard 스크립트 연결 | ~1 |
| [NEW] [postinstall-guard.cjs](file:///Users/junny/Documents/BlogProject/cli-jaw/scripts/postinstall-guard.cjs) | 크로스플랫폼 CJS 가드 | +37 |
| [postinstall.ts](file:///Users/junny/Documents/BlogProject/cli-jaw/bin/postinstall.ts) | Node 가드 + JAW_HOME inline | +12, -2 |
| [mcp-sync.ts](file:///Users/junny/Documents/BlogProject/cli-jaw/lib/mcp-sync.ts) | config.ts import → inline JAW_HOME | +4, -1 |
| [jaw-home-import.test.ts](file:///Users/junny/Documents/BlogProject/cli-jaw/tests/unit/jaw-home-import.test.ts) | P20-001/002 테스트 업데이트 | ~15 |

---

## 검증

| ID | 시나리오 | 기대 | 커맨드 |
|---:|----------|------|--------|
| PI-01 | 클린 클론 + `npm install` | tsc 자동 빌드 → postinstall 정상 | `rm -rf dist && npm install` |
| PI-02 | `dist/` 이미 존재 | postinstall 직접 실행 (tsc 스킵) | `npm install` |
| PI-03 | tsc 실패 (타입 에러 유발) | **npm install 실패 (exit 1)** | 의도적 타입에러 삽입 후 `rm -rf dist && npm install` |
| PI-04 | postinstall.js 런타임 에러 | **npm install 실패 (exit 1)** | 직접 에러 삽입 후 `npm install` |
| PI-05 | Node 18에서 실행 | 에러 메시지 + exit(1) | `nvm use 18 && node dist/bin/postinstall.js` |
| PI-06 | 기존 테스트 전체 | 314+ pass | `npx tsx --test tests/*.test.ts tests/**/*.test.ts` |
| PI-07 | typecheck | 0 errors | `npx tsc --noEmit` |

---

## 후속 작업 (별도 devlog)

| 항목 | devlog |
|------|--------|
| 글로벌 설치 분리 → `jaw init --safe` | [safe_install PLAN](file:///Users/junny/Documents/BlogProject/cli-jaw/devlog/260226_refactor_all/260226_safe_install/PLAN.md) |
| `skills_ref/` git 분리 | [repo_hygiene PLAN](file:///Users/junny/Documents/BlogProject/cli-jaw/devlog/260226_refactor_all/260226_repo_hygiene/PLAN.md) |
