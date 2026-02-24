# Phase 0: CLI Fallback Configuration

> **날짜**: 2026-02-24
> **상태**: 설계 확정 + 검증 완료 → 구현 대기
> **관련**: [config.js](file:///Users/jun/Developer/new/700_projects/cli-claw/src/config.js), [agent.js](file:///Users/jun/Developer/new/700_projects/cli-claw/src/agent.js)
> **검증**: Gemini 코드 대조 완료 (4개 필수 수정 반영)

---

## 개요

CLI 실행 실패 시(429, auth 오류 등) 자동으로 다른 CLI로 **1회만** 재시도하는 폴백 기능.

---

## 설계: Global Fallback Block

### 설정

`settings.json`에 글로벌 순서 리스트 추가:

```json
{
  "fallbackOrder": ["codex", "claude"]
}
```

- `fallbackOrder: []` → 폴백 비활성화 (기본값)
- 리스트 순서 = 우선순위

### 동작 규칙

| 규칙               | 설명                                             |
| ------------------ | ------------------------------------------------ |
| **자기 자신 점프** | 리스트에서 현재 CLI와 동일한 항목은 skip         |
| **1회 제한**       | 폴백은 딱 1번만. 폴백의 폴백은 시도 안 함        |
| **설치 확인**      | `detectCli()`로 폴백 대상이 설치되어 있는지 확인 |

### 흐름 예시

설정: `fallbackOrder: ["codex", "claude"]`

| 실패한 CLI | 폴백 대상                 | 결과                   |
| ---------- | ------------------------- | ---------------------- |
| gemini     | codex (1번째, ≠ self)     | 1회 시도 → 실패하면 끝 |
| codex      | ~~codex~~ (skip) → claude | 1회 시도 → 실패하면 끝 |
| claude     | codex (1번째, ≠ self)     | 1회 시도 → 실패하면 끝 |
| opencode   | codex (1번째, ≠ self)     | 1회 시도 → 실패하면 끝 |

### 2→2 순환 문제

**해결**: `_isFallback` 플래그로 1회 제한. 체이닝 없음.

```
gemini 실패 → codex 시도 (_isFallback: true)
  → codex 실패 → _isFallback이므로 추가 폴백 없이 에러 표시
```

---

## 변경 범위

| 파일                             | 변경 내용                                            |
| -------------------------------- | ---------------------------------------------------- |
| `src/config.js`                  | `DEFAULT_SETTINGS`에 `fallbackOrder: []` 추가        |
| `src/agent.js`                   | `child.on('close')` 에러 분기에 폴백 로직            |
| `server.js`                      | `applySettingsPatch()`에서 `fallbackOrder` 깊은 머지 |
| `src/commands.js`                | `/fallback` 커맨드 추가 (cli, web, telegram)         |
| `public/js/features/settings.js` | 폴백 순서 설정 UI                                    |
| `public/index.html`              | 폴백 설정 DOM 요소                                   |
| `src/telegram.js`                | `updateSettings` 폴백 허용 + 알림                    |

---

## 1. Backend: agent.js 핵심 로직

`spawnAgent` 함수의 `child.on('close')` (L302~354) 에러 분기 변경:

```javascript
// child.on('close') 내부, code !== 0 분기 (L336~346)
if (!forceNew && code !== 0 && !opts.internal && !opts._isFallback) {
    const fallbackCli = (settings.fallbackOrder || [])
        .find(fc => fc !== cli && detectCli(fc).available);
    
    if (fallbackCli) {
        console.log(`[claw:fallback] ${cli} failed (exit ${code}) → ${fallbackCli}`);
        broadcast('agent_fallback', {
            from: cli, to: fallbackCli,
            reason: errMsg,
        });
        
        // 폴백 CLI로 재시도 — _isFallback으로 1회 제한 + insertMessage 스킵
        const { promise } = spawnAgent(prompt, {
            ...opts, cli: fallbackCli, _isFallback: true, _skipInsert: true
        });
        promise.then(r => resolve(r));
        return; // 기존 resolve/broadcast 건너뛰기
    }
    
    // 폴백 불가 → 기존 에러 표시
    broadcast('agent_done', { text: `❌ ${errMsg}`, error: true });
}
```

> [!CAUTION]
> **DB 중복 저장 방지** (검증에서 발견)
> `spawnAgent` L246: `insertMessage.run('user', prompt, cli, model)` 이
> 폴백 재시도 시에도 실행되면 사용자 메시지가 2번 저장됨.
> `_skipInsert` 옵션 추가로 폴백 호출 시 `insertMessage` 건너뛰기:
> ```javascript
> // L246 수정
> if (!forceNew && !opts.internal && !opts._skipInsert) {
>     insertMessage.run('user', prompt, cli, model);
> }
> ```

> [!IMPORTANT]
> `activeProcess` 관리: 폴백 spawn 시 기존 `activeProcess = null` 설정 후
> 새 spawn이 `activeProcess`를 다시 점유. `forceNew`는 false이므로 자연스럽게 처리됨.

### 주의: orchestrateAndCollect와의 상호작용

`telegram.js`의 `orchestrateAndCollect()` (L50~85)는 `orchestrate_done` 이벤트를 기다림.
폴백 발동 시 `orchestrate_done`은 폴백 CLI가 완료된 후에만 발생하므로 **추가 변경 불필요**.

흐름:
```
tgOrchestrate → orchestrate → spawnAgent(claude)
  → claude 실패 → spawnAgent(codex, _isFallback)
  → codex 완료 → orchestrate_done 발생
  → orchestrateAndCollect가 정상 수집
```

---

## 2. Backend: config.js 설정

```diff
 export const DEFAULT_SETTINGS = {
     cli: 'claude',
+    fallbackOrder: [],
     perCli: { ... },
```

### server.js `applySettingsPatch()` (L220)

`fallbackOrder`는 단순 배열이므로 기존 깊은 머지 로직(`perCli`, `heartbeat` 등과 동일)이 적용됨.
`PUT /api/settings` body에 `{ "fallbackOrder": ["codex", "claude"] }` 전송하면 자동 반영.

```javascript
// applySettingsPatch 내부 — 이미 처리됨:
// 배열 타입은 Object.assign 대신 직접 교체 (기존 동작)
```

> [!NOTE]
> `applySettingsPatch()`는 `for (const key of ['perCli', 'heartbeat', 'telegram', 'memory'])` 루프로
> 객체 키만 깊은 머지. `fallbackOrder`는 배열이므로 최상위 assign으로 자동 교체됨 — 추가 코드 불필요.

---

## 3. Frontend: Web UI (settings.js)

### 위치: 설정 패널 사이드바 → "Per-CLI 설정" 아래

기존 구조 ([frontend.md](file:///Users/jun/Developer/new/700_projects/cli-claw/devlog/str_func/frontend.md) 참조):
- `settings.js` (351L): `loadSettings()`, `savePerCli()`, `onCliChange()` 등
- `constants.js` (23L): `MODEL_MAP`
- `index.html` (421L): DOM 구조

### index.html 추가 DOM

```html
<!-- 기존 perCli 설정 그룹 아래에 추가 -->
<div class="settings-group">
  <label>⚡ Fallback 순서</label>
  <p style="font-size:11px;color:var(--text-dim);margin:4px 0">
    CLI 실패 시 자동 재시도할 순서. 빈 값 = 비활성화
  </p>
  <div id="fallbackOrderList" class="fallback-order-list"></div>
</div>
```

### settings.js 추가 함수

> [!NOTE]
> **검증 반영**: inline `onchange` 제거 → `main.js`에서 이벤트 위임 (프로젝트 컨벤션).
> 체크박스 → `<select>` 드롭다운으로 변경 (순서를 직관적으로 조정 가능).

```javascript
// ── Fallback Order ──

export function loadFallbackOrder(s) {
    const container = document.getElementById('fallbackOrderList');
    const allClis = Object.keys(s.perCli || {});
    const active = s.fallbackOrder || [];
    
    // Fallback 1, Fallback 2 드롭다운
    let html = '';
    for (let i = 0; i < 2; i++) {
        const current = active[i] || '';
        const opts = allClis.map(cli =>
            `<option value="${cli}" ${cli === current ? 'selected' : ''}>${cli}</option>`
        ).join('');
        html += `
            <div class="fallback-slot" style="margin:4px 0">
                <span style="font-size:11px;color:var(--text-dim)">Fallback ${i + 1}:</span>
                <select id="fallback${i}" class="fallback-select">
                    <option value="">(없음)</option>
                    ${opts}
                </select>
            </div>`;
    }
    container.innerHTML = html;
}

export async function saveFallbackOrder() {
    const fb1 = document.getElementById('fallback0')?.value;
    const fb2 = document.getElementById('fallback1')?.value;
    const fallbackOrder = [fb1, fb2].filter(Boolean);
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fallbackOrder }),
    });
}
```

```javascript
// main.js — 이벤트 바인딩 (프로젝트 컨벤션)
import { saveFallbackOrder } from './features/settings.js';
document.getElementById('fallbackOrderList')
    .addEventListener('change', saveFallbackOrder);
```

### loadSettings() 수정

```diff
 export async function loadSettings() {
     const s = await (await fetch('/api/settings')).json();
     // ...기존 코드...
     loadTelegramSettings(s);
+    loadFallbackOrder(s);
     loadMcpServers();
 }
```

---

## 4. `/fallback` 슬래시 커맨드 (CLI · Web · Telegram)

모든 인터페이스에서 동일하게 동작하는 `/fallback` 커맨드 추가.
모델/effort 설정 없음 — 해당 CLI의 `perCli` 기본값 자동 사용.

### commands.js 등록

```javascript
{
    name: 'fallback',
    desc: '폴백 CLI 순서 설정',   // ⚠️ description이 아닌 desc (프로젝트 컨벤션)
    args: ['cli1', 'cli2', '...'],
    interfaces: ['cli', 'web', 'telegram'],  // 3곳 전부
    handler: async (args, ctx) => {
        const settings = ctx.getSettings();
        const available = Object.keys(settings.perCli || {});
        
        // 인수 없으면 현재 상태 표시
        if (!args.length) {
            const fb = settings.fallbackOrder || [];
            return {
                ok: true, type: 'info',
                text: fb.length
                    ? `⚡ Fallback: ${fb.join(' → ')}` 
                    : `⚡ Fallback: 비활성화\n사용 가능: ${available.join(', ')}`,
            };
        }
        
        // 'off' / 'none' → 비활성화
        if (args[0] === 'off' || args[0] === 'none') {
            await ctx.updateSettings({ fallbackOrder: [] });
            return { ok: true, text: '⚡ Fallback 비활성화됨' };
        }
        
        // 유효한 CLI만 필터
        const order = args.filter(a => available.includes(a));
        if (!order.length) {
            return { ok: false, text: `❌ 유효한 CLI 없음\n사용 가능: ${available.join(', ')}` };
        }
        
        await ctx.updateSettings({ fallbackOrder: order });
        return { ok: true, text: `⚡ Fallback 설정: ${order.join(' → ')}` };
    },
}
```

### 사용 예시

```bash
# 현재 폴백 상태 확인
/fallback
# → ⚡ Fallback: codex → claude

# 폴백 설정 (codex 우선, claude 대안)
/fallback codex claude
# → ⚡ Fallback 설정: codex → claude

# 폴백 비활성화
/fallback off
# → ⚡ Fallback 비활성화됨
```

### Telegram `updateSettings` 허용 범위 확장

현재 `makeTelegramCommandCtx`의 `updateSettings`는 전면 read-only (L123).
`fallbackOrder`만 예외로 허용:

```javascript
// telegram.js — makeTelegramCommandCtx 수정
updateSettings: async (patch) => {
    // fallbackOrder 변경만 허용
    if (patch.fallbackOrder !== undefined && Object.keys(patch).length === 1) {
        const { replaceSettings, saveSettings } = await import('./config.js');
        replaceSettings({ ...settings, ...patch });
        saveSettings(settings);
        return { ok: true };
    }
    return { ok: false, text: '❌ Telegram에서 설정 변경은 지원하지 않습니다.' };
},
```

> [!NOTE]
> `/model`, `/cli`는 여전히 TG에서 read-only. `/fallback`만 예외 허용.
> 사유: 폴백은 안전한 설정 (실행 CLI 자체를 바꾸지 않음, 실패 시에만 작동).

### CLI 채팅 (chat.js) 알림

폴백 발동 시 `agent_fallback` broadcast → chat.js TUI에서도 표시:

```javascript
// bin/commands/chat.js — ws 메시지 핸들러에 추가
case 'agent_fallback':
    printLine(`⚡ ${data.from} 실패 → ${data.to}로 재시도...`, 'warn');
    break;
```

### `/status` 커맨드에 현재 폴백 상태 추가

```javascript
// statusHandler 확장
const fb = settings.fallbackOrder || [];
if (fb.length) lines.push(`Fallback: ${fb.join(' → ')}`);
```

---

## 5. Telegram 통합

### 자동 동작 (변경 불필요)

`tgOrchestrate()` → `orchestrateAndCollect()` → `orchestrate()` → `spawnAgent()` 경로.
폴백은 `spawnAgent` 내부에서 발생 — **추가 변경 불필요**.

### 폴백 알림

`orchestrateAndCollect()` (L50~85)의 handler에 `agent_fallback` 추가:

```javascript
const handler = (type, data) => {
    if (type === 'agent_fallback') resetTimeout();
    // ...
};
```

`tgOrchestrate()`의 `toolHandler`에서 폴백 표시:

```javascript
if (type === 'agent_fallback') {
    toolLines.push(`⚡ ${data.from} → ${data.to}`);
}
```

---

## 6. Broadcast 이벤트

새 이벤트 타입 추가:

```javascript
broadcast('agent_fallback', {
    from: 'claude',       // 실패한 CLI
    to: 'codex',          // 폴백 대상
    reason: 'API 429',    // 실패 사유
});
```

### 수신처

| 모듈                    | 이벤트           | 동작                                  |
| ----------------------- | ---------------- | ------------------------------------- |
| `ws.js` (Web)           | `agent_fallback` | 채팅 영역에 폴백 알림 표시            |
| `chat.js` (CLI TUI)     | `agent_fallback` | 터미널에 `⚡ fallback` 표시            |
| `telegram.js`           | `agent_fallback` | tool handler에서 상태 메시지 업데이트 |
| `orchestrateAndCollect` | `agent_fallback` | idle timeout 리셋                     |

---

## 7. 리스크

| 리스크                  | 확률 | 영향 | 대응                                                                                                                                                                                                                              |
| ----------------------- | ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TG 이중 실패 무응답** | 보통 | 높음 | `orchestrateAndCollect`가 `agent_done` 에러 텍스트를 최종 응답으로 사용하지 않아, 폴백도 실패 시 TG에서 "응답 없음"으로 보일 수 있음. → `orchestrateAndCollect` handler에서 `agent_done` + `error: true`도 수집 대상에 포함시키기 |
| DB 중복 저장            | 높음 | 보통 | `_skipInsert` 옵션 추가로 해결 (§1 참조)                                                                                                                                                                                          |
| 폴백 CLI 미설치         | 낮음 | 낮음 | `detectCli()` 확인 후 skip — 이미 설계에 포함                                                                                                                                                                                     |

---

## 다음 단계

- [ ] `config.js`에 `fallbackOrder` 추가
- [ ] `agent.js` `child.on('close')`에 폴백 로직 삽입
- [ ] `agent_fallback` broadcast 이벤트 추가
- [ ] `commands.js`에 `/fallback` 커맨드 등록
- [ ] `telegram.js` `updateSettings` 폴백 예외 허용
- [ ] `index.html` + `settings.js` 폴백 UI
- [ ] `ws.js` + `chat.js` 폴백 이벤트 표시
- [ ] `telegram.js` toolHandler에 폴백 알림
- [ ] `/status` 커맨드에 폴백 상태 추가
- [ ] 테스트: `/fallback codex claude` 전 인터페이스
- [ ] 테스트: 잘못된 모델 → 폴백 발동
- [ ] 테스트: 2→2 순환 방지 확인
