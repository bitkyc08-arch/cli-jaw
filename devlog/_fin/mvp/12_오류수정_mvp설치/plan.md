# Phase 12: 설정 통합 + 오류수정 + MVP 설치

> Planning Agent 별도 설정 제거 + perCli는 기본값 테이블로 유지 + 버그 수정

---

## 1. 현재 문제

### 1.1 겹치는 설정 경로

```
settings.cli              ← "Active CLI" (Agents 탭 상단)
settings.perCli[cli]      ← CLI별 기본 model/effort (Settings 탭)
settings.planning.cli     ← Planning Agent CLI (Agents 탭 하단) ← ❌ 겹침!
settings.planning.model   ← Planning Agent model              ← ❌ perCli 무시
settings.planning.effort  ← Planning Agent effort              ← ❌ 겹침!
```

**문제**: Active CLI와 Planning CLI가 분리되어 있어 사용자 혼동.
`orchestrate()`에서 `planning.model`이 `perCli` 기본값을 무시함.

### 1.2 의존성 추적

| 코드 위치              | 현재 참조                                            | 문제                                     |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `spawnAgent()`         | `opts.cli \|\| session.active_cli \|\| settings.cli` | ✅ 정상                                   |
| `spawnAgent()`         | `settings.perCli?.[cli].model/effort`                | ✅ perCli 참조                            |
| `orchestrate()`        | `settings.planning?.cli \|\| settings.cli`           | ❌ **planning이 cli 덮어씀**              |
| `orchestrate()`        | `settings.planning?.model \|\| 'default'`            | ❌ **perCli 무시하고 'default' fallback** |
| `PUT /api/settings`    | `settings.perCli?.[settings.cli]?.model`             | ✅ perCli에서 읽음                        |
| `triggerMemoryFlush()` | `settings.perCli?.[cli]?.model`                      | ✅ perCli fallback                        |
| `distributeAndWait()`  | `emp.cli, emp.model`                                 | ✅ Sub-agent 자체 설정                    |

---

## 2. 목표 구조

### 2.1 변경 요약

```
❌ settings.planning (삭제)
✅ settings.perCli (유지 — 각 CLI의 기본값 테이블)
```

| Before            | After                                      |
| ----------------- | ------------------------------------------ |
| `planning.cli`    | **삭제** — Active CLI가 planning           |
| `planning.model`  | **삭제** — `perCli[activeCli].model` 사용  |
| `planning.effort` | **삭제** — `perCli[activeCli].effort` 사용 |
| `perCli` 4블록    | **유지** — 모든 곳에서 참조                |

### 2.2 참조 흐름 (After)

```
perCli (Settings 탭, 4블록 유지)
  ├─ spawnAgent(no opts) → perCli[settings.cli].model/effort
  ├─ orchestrate()       → perCli[settings.cli] (= planning)
  ├─ distributeAndWait() → emp.cli → perCli[emp.cli] fallback
  ├─ triggerMemoryFlush()→ memory.cli → perCli[memoryCli]
  └─ Active CLI 표시     → perCli[settings.cli] 읽어서 model/effort 표시

Agents 탭 (새 구조):
  Active CLI: [claude ▾]
  Model: [perCli.claude의 model ▾]  ← CLI 바꾸면 자동 변경
  Effort: [perCli.claude의 effort ▾]
  Permissions: [Safe] [Auto]
  Working Dir: [~/]
  ─────────────
  Sub Agents
```

### 2.3 새 `DEFAULT_SETTINGS`

```javascript
const DEFAULT_SETTINGS = {
    cli: 'claude',
    permissions: 'auto',
    workingDir: os.homedir(),
    perCli: {   // ← 유지! 각 CLI의 기본값
        claude:   { model: 'claude-sonnet-4-5-20250929', effort: 'medium' },
        codex:    { model: 'gpt-5.3-codex', effort: 'medium' },
        gemini:   { model: 'gemini-2.5-pro', effort: '' },
        opencode: { model: 'github-copilot/claude-sonnet-4.5', effort: '' },
    },
    // planning: 삭제됨 — Active CLI = Planning CLI
    heartbeat: { ... },
    telegram: { ... },
    memory: { enabled: true, flushEvery: 10, cli: '', model: '', retentionDays: 30 },
    employees: [],
};
```

---

## 3. 변경 파일 목록

### 3.1 `server.js`

#### A. `DEFAULT_SETTINGS` 에서 `planning` 키 삭제 (L201-230)

```diff
 const DEFAULT_SETTINGS = {
     cli: 'claude',
     permissions: 'auto',
     workingDir: os.homedir(),
     perCli: { ... },  // 유지
-    planning: {        // 삭제
-        cli: 'claude',
-        model: 'default',
-        effort: 'medium',
-    },
     heartbeat: { ... },
     ...
 };
```

#### B. 마이그레이션 — 기존 `settings.json`에서 `planning` 제거

```javascript
function migrateSettings(s) {
    // planning → 삭제 (perCli로 통합)
    if (s.planning) {
        // planning.cli가 다르면 active CLI로 가져옴
        if (s.planning.cli && s.planning.cli !== s.cli) {
            s.cli = s.planning.cli;
        }
        // planning.model이 명시적이면 perCli에 반영
        if (s.planning.model && s.planning.model !== 'default') {
            const target = s.perCli?.[s.cli];
            if (target) target.model = s.planning.model;
        }
        if (s.planning.effort) {
            const target = s.perCli?.[s.cli];
            if (target) target.effort = s.planning.effort;
        }
        delete s.planning;
    }
    return s;
}

function loadSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        const merged = migrateSettings({ ...DEFAULT_SETTINGS, ...raw });
        saveSettings(merged); // 마이그레이션 후 저장
        return merged;
    } catch { return { ...DEFAULT_SETTINGS }; }
}
```

#### C. `orchestrate()` 단순화 (L942-946)

```javascript
// Before
const planCli = settings.planning?.cli || settings.cli;
const planModel = settings.planning?.model || 'default';
const planEffort = settings.planning?.effort || '';
const planOpts = { agentId: 'planning', cli: planCli, model: planModel, effort: planEffort };

// After — Active CLI = Planning, perCli에서 model/effort 읽음
const planOpts = { agentId: 'planning' };
// spawnAgent 내부에서:
//   cli = settings.cli
//   model = settings.perCli[cli].model
//   effort = settings.perCli[cli].effort
```

#### D. `PUT /api/settings` — planning deep merge 제거

```diff
-    for (const key of ['perCli', 'planning', 'heartbeat', 'telegram']) {
+    for (const key of ['perCli', 'heartbeat', 'telegram', 'memory']) {
```

#### E. `triggerMemoryFlush()` — 이미 정상

```javascript
// 현재 코드 (이미 perCli fallback 사용)
const flushCli = settings.memory?.cli || settings.cli;
const flushModel = settings.memory?.model || (settings.perCli?.[flushCli]?.model) || 'default';
// → 변경 없음 ✅
```

---

### 3.2 `index.html`

#### A. Agents 탭 — Planning Agent 섹션 삭제 + Model/Effort 상단 이동

**Before:**
```
Active CLI: [claude ▾]
Permissions: [Safe] [Auto]
Working Directory: [~/]
─────
🎯 Planning Agent          ← 삭제
  CLI: [claude ▾]           ← 삭제
  Model: [default ▾]        ← 삭제
  Effort: [medium ▾]        ← 삭제
─────
Sub Agents
```

**After:**
```
Active CLI: [claude ▾]
Model: [claude-sonnet-4-5 ▾]   ← perCli[cli].model 표시
Effort: [medium ▾]              ← perCli[cli].effort 표시
Permissions: [Safe] [Auto]
Working Directory: [~/]
─────
Sub Agents
```

**HTML** (Planning Agent 섹션 L776-802 삭제, Model/Effort 추가):
```html
<div id="tabAgents" class="tab-content active">
    <div>
        <label>Active CLI</label>
        <select id="selCli" onchange="onCliChange()">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
            <option value="opencode">OpenCode</option>
        </select>
    </div>
    <div>
        <label>Model</label>
        <select id="selModel" onchange="saveActiveCliSettings()"></select>
    </div>
    <div>
        <label>Effort</label>
        <select id="selEffort" onchange="saveActiveCliSettings()">
            <option value="">— none</option>
            <option value="low">🟢 low</option>
            <option value="medium" selected>🟡 medium</option>
            <option value="high">🔴 high</option>
        </select>
    </div>
    <div>
        <label>Permissions</label>
        <div class="perm-toggle">...</div>
    </div>
    <div>
        <label>Working Directory</label>
        <input type="text" id="inpCwd" value="~/" onchange="updateSettings()">
    </div>
    <hr>
    <!-- Sub Agents -->
</div>
```

#### B. Settings 탭 — perCli 4블록 **유지**

그대로 유지. 각 CLI의 기본 model/effort 설정.
CLI 바꿔도 Settings 탭의 기본값은 변하지 않음.

#### C. JS — Active CLI 바꾸면 Model/Effort 자동 표시

```javascript
function onCliChange() {
    const cli = document.getElementById('selCli').value;
    const models = MODEL_MAP[cli] || [];
    const modelSel = document.getElementById('selModel');
    modelSel.innerHTML = models.map(m =>
        `<option value="${m}">${m}</option>`
    ).join('');

    // perCli 기본값 로드
    fetch('/api/settings').then(r => r.json()).then(s => {
        const cfg = s.perCli?.[cli] || {};
        if (cfg.model) modelSel.value = cfg.model;
        if (cfg.effort) document.getElementById('selEffort').value = cfg.effort;
    });

    updateSettings(); // CLI 변경 저장
}

// Active CLI의 model/effort 변경 → perCli에 저장
async function saveActiveCliSettings() {
    const cli = document.getElementById('selCli').value;
    const perCli = {};
    perCli[cli] = {
        model: document.getElementById('selModel').value,
        effort: document.getElementById('selEffort').value,
    };
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perCli }),
    });
}
```

#### D. JS 삭제

- `savePlanningSettings()` — planning 제거
- `loadPlanningSettings()` — planning 제거

#### E. JS `loadSettings()` 수정

```javascript
async function loadSettings() {
    const s = await (await fetch('/api/settings')).json();
    document.getElementById('selCli').value = s.cli;
    document.getElementById('inpCwd').value = s.workingDir;
    document.getElementById('headerCli').textContent = s.cli;
    setPerm(s.permissions, false);

    // Active CLI의 model/effort 표시
    onCliChange();

    // per-CLI 기본값 로드 (Settings 탭)
    if (s.perCli) {
        for (const [cli, cfg] of Object.entries(s.perCli)) {
            const cap = cli.charAt(0).toUpperCase() + cli.slice(1);
            const modelEl = document.getElementById('model' + cap);
            const effortEl = document.getElementById('effort' + cap);
            if (modelEl && cfg.model) modelEl.value = cfg.model;
            if (effortEl && cfg.effort) effortEl.value = cfg.effort;
        }
    }
    loadTelegramSettings(s);
}
```

---

### 3.3 삭제 목록

| 파일         | 삭제                                               | 이유              |
| ------------ | -------------------------------------------------- | ----------------- |
| `server.js`  | `settings.planning` 기본값 + 관련 코드             | Active CLI로 통합 |
| `index.html` | Planning Agent 섹션 (L776-802)                     | Active CLI에 흡수 |
| `index.html` | `savePlanningSettings()`, `loadPlanningSettings()` | 불필요            |

### 3.4 유지 목록

| 파일         | 유지                                     | 이유                   |
| ------------ | ---------------------------------------- | ---------------------- |
| `server.js`  | `settings.perCli` 4블록                  | 각 CLI의 기본값 테이블 |
| `server.js`  | `spawnAgent()` perCli 참조               | 정상 동작              |
| `server.js`  | `PUT /api/settings` perCli deep merge    | Settings 탭에서 저장   |
| `index.html` | Settings 탭 Claude/Codex/Gemini/OpenCode | 기본값 편집 UI         |

---

## 4. 알려진 버그

| #   | 버그                               | 위치               | 수정                      |
| --- | ---------------------------------- | ------------------ | ------------------------- |
| B1  | `npm i -g` 후 `Cannot find module` | `package.json` bin | 경로 + postinstall 점검   |
| B2  | Grammy 409 (두 번째 봇 인스턴스)   | telegram init      | `bot.stop()` guard        |
| B3  | Escape 키 → Memory 모달 안 닫힘    | index.html keydown | `closeMemoryModal()` 추가 |

---

## 5. 구현 순서

- [ ] 12.1 `server.js` — `planning` 삭제 + `migrateSettings()`
- [ ] 12.2 `server.js` — `orchestrate()` planning → Active CLI
- [ ] 12.3 `server.js` — `PUT /api/settings` planning deep merge 제거
- [ ] 12.4 `index.html` — Planning Agent 섹션 삭제
- [ ] 12.5 `index.html` — Agents 탭에 Model/Effort 추가 + `onCliChange()`
- [ ] 12.6 `index.html` — `savePlanningSettings()` 등 삭제
- [ ] 12.7 Bug fixes (B1-B3)
- [ ] 12.8 `npm i -g cli-claw` 테스트
- [ ] 12.9 README 업데이트
