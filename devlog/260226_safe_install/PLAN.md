# Safe Install Mode — `jaw init --safe`

**Date**: 2026-02-26  
**Status**: 📋 Plan  

---

## 문제

현재 `npm install -g cli-jaw`의 postinstall은 **무조건 실행**:
- 5개 CLI 글로벌 설치 (@latest)
- MCP 서버 글로벌 설치
- `~/.agents/skills/` 심링크 생성
- `~/AGENTS.md` → `~/CLAUDE.md` 심링크
- `~/.cli-jaw/mcp.json` 생성 + 기존 설정 병합
- `uv`, `playwright-core` 설치

**기존 환경에 영향을 줄 수 있는 동작**이 사전 동의 없이 실행됨.

---

## 설계

### 진입점 2가지

```bash
# 방법 1: postinstall에서 safe 모드 감지
npm install -g cli-jaw          # → 기존 동작 (자동 설치)
JAW_SAFE=1 npm install -g cli-jaw  # → safe 모드 (스킵, 나중에 jaw init)

# 방법 2: 별도 init 커맨드
jaw init              # → 자동 모드 (현재 postinstall과 동일)
jaw init --safe       # → 대화형 y/n 프롬프트
jaw init --dry-run    # → 변경 없이 계획만 표시
```

### Safe 모드 흐름

```
$ jaw init --safe

🦈 CLI-JAW Safe Setup
  Home: ~/.cli-jaw

── 1. 디렉토리 생성 ──────────────────────
  ~/.cli-jaw/          (config)
  ~/.cli-jaw/skills/   (skills)
  ~/.cli-jaw/uploads/  (media)
→ Create directories? [Y/n] y
✅ created

── 2. CLI 도구 설치 (@latest) ────────────
  현재 상태:
  claude    ✅ installed (v1.2.3)
  codex     ✅ installed (v0.8.1)
  gemini    ❌ not found
  copilot   ⚠️  outdated (0.0.361 → 0.0.418)
  opencode  ✅ installed (v0.4.2)

→ Install/update gemini? [Y/n] y
→ Update copilot 0.0.361 → latest? [Y/n] y
→ Skip already installed? [Y/n] y
✅ 2 installed, 3 skipped

── 3. Skills 심링크 ──────────────────────
  ~/.agents/skills/ → ~/.cli-jaw/skills/
  기존 ~/.agents/skills/ 감지됨 (15 files)

→ Backup existing and create symlink? [Y/n] n
⏭️  skipped (기존 유지)

── 4. MCP 설정 ───────────────────────────
  ~/.cli-jaw/mcp.json 생성
  기존 .mcp.json 감지됨:
    context7 ✅
    filesystem ✅

→ Import existing MCP servers? [Y/n] y
→ Install @upstash/context7-mcp globally? [Y/n] y
✅ mcp.json created (2 servers imported)

── 5. Custom Instructions ────────────────
  ~/AGENTS.md → ~/CLAUDE.md 심링크
  기존 ~/CLAUDE.md 감지됨

→ Replace ~/CLAUDE.md with symlink? [y/N] n
⏭️  skipped

── 6. Skill Dependencies ────────────────
  uv (Python skills)        ❌ not found
  playwright-core (browser) ✅ installed

→ Install uv? [Y/n] y
✅ uv installed

── 7. Default Skills 복사 ────────────────
  skills_ref/ → ~/.cli-jaw/skills_ref/
  17 active skills, 90+ reference skills

→ Copy default skills? [Y/n] y
✅ 107 skills copied

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦈 Setup complete!
  5 installed, 2 skipped, 0 failed
  Run: jaw serve
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 변경 파일

| 파일                         | 변경                                   |
| ---------------------------- | -------------------------------------- |
| [NEW] `bin/commands/init.ts` | `jaw init [--safe] [--dry-run]` 커맨드 |
| `bin/cli-jaw.ts`             | `init` 서브커맨드 등록                 |
| `bin/postinstall.ts`         | `JAW_SAFE=1` 감지 → init 스킵          |

### `init.ts` 핵심 구조

```typescript
// bin/commands/init.ts
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, def = true): Promise<boolean> =>
    new Promise(r => rl.question(`${q} [${def ? 'Y/n' : 'y/N'}] `, a => {
        r(a.trim() === '' ? def : /^y/i.test(a));
    }));

const safe = process.argv.includes('--safe');
const dryRun = process.argv.includes('--dry-run');

async function run() {
    // Step 1-7: 각 단계별 상태 체크 + (safe ? ask() : true) + 실행/스킵
}
```

### `postinstall.ts` 변경

```diff
+if (process.env.JAW_SAFE === '1') {
+    console.log('[jaw:init] safe mode — run `jaw init --safe` after install');
+    // 디렉토리 생성만 하고 나머지 스킵
+    ensureDir(jawHome);
+    process.exit(0);
+}
```

---

## Dry-run 모드

```
$ jaw init --dry-run

🦈 CLI-JAW Setup Plan (dry-run, no changes)

  1. Create dirs: ~/.cli-jaw/{skills,uploads}
  2. Install CLIs:
     - gemini: npm i -g @google/gemini-cli@latest
     - copilot: npm i -g copilot@latest (update 0.0.361)
  3. Skills symlink: ~/.agents/skills/ → ~/.cli-jaw/skills/
     ⚠️  existing dir will be backed up
  4. MCP: create ~/.cli-jaw/mcp.json (import 2 existing servers)
  5. CLAUDE.md: skip (already exists)
  6. Dependencies: install uv
  7. Default skills: copy 107 skills

Run without --dry-run to execute.
```

---

## 테스트

| ID    | 시나리오                         | 기대                           |
| ----- | -------------------------------- | ------------------------------ |
| SI-01 | `jaw init` (자동)                | 현재 postinstall과 동일 동작   |
| SI-02 | `jaw init --safe` 전부 y         | SI-01과 동일 결과              |
| SI-03 | `jaw init --safe` 전부 n         | 디렉토리만 생성, 나머지 스킵   |
| SI-04 | `jaw init --dry-run`             | 출력만, 파일시스템 변경 없음   |
| SI-05 | `JAW_SAFE=1 npm i -g cli-jaw`    | postinstall 스킵 + 안내 메시지 |
| SI-06 | 이미 설정 완료된 환경에서 재실행 | 기존 설정 보존                 |
