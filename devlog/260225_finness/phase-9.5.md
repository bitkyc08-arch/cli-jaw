# Phase 9.5: Command Contract v2 — 인터페이스 통합 + Help 통일 (WS6)

> CMD line / CLI chat / Web / Telegram 커맨드 체계를 단일소스로 통합한다.

---

## 왜 해야 하는가

### 현재 문제 (Phase 8 §22에서 감사)

**1) root help 하드코딩 + 누락**

```js
// bin/cli-claw.js — printHelp()
function printHelp() {
  console.log(`
Commands:
  chat     Start interactive chat
  config   Show/edit settings
  // ... 수동 텍스트
  // ❌ browser, memory 서브커맨드 누락
  `);
}
```

`bin/cli-claw.js`의 switch에 `browser`, `memory`가 있지만 `printHelp()`에 안 보임.

**2) Telegram 메뉴 vs /help 불일치**

```js
// src/telegram.js
const TG_EXCLUDED_CMDS = new Set(['model', 'cli']);
// setMyCommands에서 제외하지만...
// /help에서는 model, cli가 계속 표시됨
```

사용자가 /help에서 `/model` 보고 실행하면 `readonly` 안내만 나옴 → UX 혼란.

**3) Web 자동완성 미연결**

```js
// public/js/features/slash-commands.js
// 현재 /api/commands에서 리스트만 받아서 prefix 필터
// src/commands.js의 getArgumentCompletionItems() 미사용
```

**4) 인터페이스 capability 분산**

```js
// 4곳에 분산된 ctx 정의
makeWebCommandCtx()      // server.js L291-328
makeCliCommandCtx()      // bin/commands/chat.js
makeTelegramCommandCtx() // src/telegram.js
// 각각 어떤 명령을 지원하는지 중앙 정의 없음
```

---

## 설계: 단일소스 Command Catalog

주의:
- 현재 코드베이스에는 `src/commands.js` 파일이 이미 존재하므로, 신규 디렉토리는 `src/command-contract/`를 사용해 경로 충돌을 피한다.

### `src/command-contract/catalog.js`

```js
import { COMMANDS } from '../commands.js';

// 인터페이스별 capability 정책 추가
export const CAPABILITY = {
  full: 'full',       // 실행 가능
  readonly: 'readonly', // 조회만 가능
  hidden: 'hidden',    // 목록에서 숨김
  blocked: 'blocked',  // 실행 차단
};

// 기존 COMMANDS 배열에 capability map 확장
export function getCommandCatalog() {
  return COMMANDS.map(cmd => ({
    ...cmd,
    capability: cmd.capability || {
      cli: CAPABILITY.full,
      web: CAPABILITY.full,
      telegram: cmd.name === 'model' || cmd.name === 'cli'
        ? CAPABILITY.readonly
        : CAPABILITY.full,
      cmdline: CAPABILITY.hidden, // root CLI는 서브커맨드 체계
    },
  }));
}
```

### `src/command-contract/policy.js`

```js
import { getCommandCatalog, CAPABILITY } from './catalog.js';

export function getVisibleCommands(iface) {
  return getCommandCatalog()
    .filter(c => {
      const cap = c.capability?.[iface];
      return cap && cap !== CAPABILITY.hidden && cap !== CAPABILITY.blocked;
    });
}

export function getExecutableCommands(iface) {
  return getCommandCatalog()
    .filter(c => c.capability?.[iface] === CAPABILITY.full);
}

export function getTelegramMenuCommands() {
  const RESERVED = new Set(['start', 'id', 'help', 'settings']);
  return getVisibleCommands('telegram')
    .filter(c => !RESERVED.has(c.name) && c.capability?.telegram === CAPABILITY.full);
}
```

### `src/command-contract/help-renderer.js`

```js
import { getVisibleCommands } from './policy.js';

export function renderHelp({ iface, commandName, format = 'text' }) {
  const cmds = getVisibleCommands(iface);

  if (!commandName) {
    const lines = cmds.map(c => {
      const cap = c.capability?.[iface];
      const tag = cap === 'readonly' ? ' [조회전용]' : '';
      return `  /${c.name}${c.args ? ' ' + c.args : ''}${tag} — ${c.desc}`;
    });
    return { ok: true, text: '사용 가능한 커맨드:\n' + lines.join('\n') };
  }

  const cmd = cmds.find(c => c.name === commandName || (c.aliases||[]).includes(commandName));
  if (!cmd) return { ok: false, text: `unknown: ${commandName}` };

  return {
    ok: true,
    text: [
      `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''} — ${cmd.desc}`,
      cmd.aliases?.length ? `별칭: ${cmd.aliases.join(', ')}` : '',
      cmd.examples?.length ? `예시:\n${cmd.examples.map(e => '  ' + e).join('\n')}` : '',
      `지원: ${Object.entries(cmd.capability||{}).filter(([,v])=>v!=='hidden').map(([k,v])=>`${k}(${v})`).join(', ')}`,
    ].filter(Boolean).join('\n'),
  };
}
```

---

## 적용 순서

### Step 1: catalog/policy/renderer 생성

```bash
mkdir -p src/command-contract
# catalog.js, policy.js, help-renderer.js
```

### Step 2: bin/cli-claw.js printHelp → renderer 교체

```diff
-function printHelp() {
-  console.log(`Commands:\n  chat  ...\n  config ...\n`);
-}
+import { renderHelp } from '../src/command-contract/help-renderer.js';
+function printHelp() {
+  console.log(renderHelp({ iface: 'cmdline' }).text);
+}
```

### Step 3: Telegram setMyCommands → policy 교체

```diff
-const TG_EXCLUDED_CMDS = new Set(['model', 'cli']);
-const menuCmds = COMMANDS.filter(c => !excluded.has(c.name));
+import { getTelegramMenuCommands } from './command-contract/policy.js';
+const menuCmds = getTelegramMenuCommands();
```

### Step 4: /api/commands 메타 확장

```diff
 app.get('/api/commands', (req, res) => {
     const iface = String(req.query.interface || 'web');
-    res.json(COMMANDS.filter(c => c.interfaces.includes(iface) && !c.hidden)
-      .map(c => ({ name: c.name, desc: c.desc, args: c.args||null })));
+    const cmds = getVisibleCommands(iface).map(c => ({
+      name: c.name, desc: c.desc, args: c.args||null,
+      category: c.category||'tools', aliases: c.aliases||[],
+      capability: c.capability?.[iface] || 'full',
+      examples: c.examples || [],
+    }));
+    ok(res, cmds);
 });
```

---

## 충돌 분석

| 대상 | 변경 | 충돌 |
|---|---|---|
| `src/command-contract/catalog.js` | **NEW** | 없음 |
| `src/command-contract/policy.js` | **NEW** | 없음 |
| `src/command-contract/help-renderer.js` | **NEW** | 없음 |
| `src/commands.js` | export 확장 (COMMANDS) | 낮음 |
| `bin/cli-claw.js` | printHelp 교체 | 낮음 |
| `src/telegram.js` | TG_EXCLUDED 제거 → policy 사용 | 중간 |
| `server.js` (9.3 분리 후 `src/routes/employees.js`) | /api/commands 수정 | 중간 |
| **순서**: 9.3(라우트 분리) 완료 후 9.5 진행이 안전 |

---

## 테스트 계획

### `tests/unit/commands-policy.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleCommands, getTelegramMenuCommands } from '../../src/command-contract/policy.js';

test('CP-001: web visible includes help', () => {
  const cmds = getVisibleCommands('web');
  assert.ok(cmds.some(c => c.name === 'help'));
});

test('CP-002: telegram menu excludes model/cli', () => {
  const cmds = getTelegramMenuCommands();
  assert.ok(!cmds.some(c => c.name === 'model'));
  assert.ok(!cmds.some(c => c.name === 'cli'));
});

test('CP-003: telegram visible includes model (readonly)', () => {
  const cmds = getVisibleCommands('telegram');
  const model = cmds.find(c => c.name === 'model');
  assert.ok(model); // 보이지만 readonly
});
```

### `tests/unit/help-renderer.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHelp } from '../../src/command-contract/help-renderer.js';

test('HP-001: list mode', () => {
  const r = renderHelp({ iface: 'web' });
  assert.ok(r.ok);
  assert.ok(r.text.includes('/help'));
});

test('HP-002: detail mode', () => {
  const r = renderHelp({ iface: 'web', commandName: 'help' });
  assert.ok(r.ok);
  assert.ok(r.text.includes('help'));
});

test('HP-003: unknown command', () => {
  const r = renderHelp({ iface: 'web', commandName: 'nonexistent' });
  assert.ok(!r.ok);
});
```

### Parity 스크립트: `scripts/check-command-parity.mjs`

```js
#!/usr/bin/env node
import { getVisibleCommands, getTelegramMenuCommands } from '../src/command-contract/policy.js';

const webCmds = getVisibleCommands('web').map(c=>c.name).sort();
const tgHelp = getVisibleCommands('telegram').map(c=>c.name).sort();
const tgMenu = getTelegramMenuCommands().map(c=>c.name).sort();

console.log('[parity] web:', webCmds.length, 'tg-help:', tgHelp.length, 'tg-menu:', tgMenu.length);

// tg-help에 있지만 tg-menu에 없는 것 = readonly/reserved (정상)
const helpOnly = tgHelp.filter(n => !tgMenu.includes(n));
console.log('[parity] tg help-only (expected readonly):', helpOnly);

// 의도치 않은 누락 확인
const unexpected = helpOnly.filter(n => !['model','cli','help','start','id','settings'].includes(n));
if (unexpected.length) {
  console.error('[parity] UNEXPECTED help-only:', unexpected);
  process.exit(1);
}
console.log('[parity] ok');
```

```bash
node scripts/check-command-parity.mjs
```

---

## 완료 기준

- [ ] `src/command-contract/{catalog,policy,help-renderer}.js` 생성
- [ ] `bin/cli-claw.js` printHelp → renderer 교체
- [ ] Telegram setMyCommands → policy 교체
- [ ] /api/commands 메타 확장
- [ ] 단위 테스트 6/6 통과
- [ ] parity 스크립트 통과
- [ ] `npm test` 통과
