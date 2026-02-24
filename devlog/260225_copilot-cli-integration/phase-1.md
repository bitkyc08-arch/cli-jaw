# Phase 1: CLI 감지 + 설정 체계 + 자동 설치 + UI

> 예상 시간: 20분

---

## 1.1 `bin/postinstall.js` — npm install 시 자동 설치

### 변경 위치: L47 (`ensureSkillsSymlinks` 호출 이후)

```js
// 2b. Copilot CLI 설치 + PATH 심링크
const copilotBin = path.join(home, '.local', 'share', 'gh', 'copilot', 'copilot');
if (!fs.existsSync(copilotBin)) {
    console.log('[claw:init] Installing GitHub Copilot CLI...');
    try {
        execSync('gh copilot --help', { stdio: 'ignore', timeout: 30000 });
    } catch (e) {
        console.log('[claw:init] ⚠️ Copilot CLI 설치 실패 (gh 미설치?):', e.message);
    }
}
const copilotLink = path.join(home, '.local', 'bin', 'copilot');
ensureDir(path.join(home, '.local', 'bin'));
ensureSymlink(copilotBin, copilotLink);
```

---

## 1.2 `src/config.js` — perCli + detectAllCli

### 변경 1: `DEFAULT_SETTINGS.perCli` (L68-73)

```diff
 perCli: {
     claude: { model: 'claude-sonnet-4-6', effort: 'medium' },
     codex: { model: 'gpt-5.3-codex', effort: 'medium' },
     gemini: { model: 'gemini-2.5-pro', effort: '' },
     opencode: { model: 'anthropic/claude-opus-4-6-thinking', effort: '' },
+    copilot: { model: 'claude-sonnet-4.6', effort: '' },
 },
```

### 변경 2: `detectAllCli()` (L162-169)

```diff
 export function detectAllCli() {
     return {
         claude: detectCli('claude'),
         codex: detectCli('codex'),
         gemini: detectCli('gemini'),
         opencode: detectCli('opencode'),
+        copilot: detectCli('copilot'),  // PATH 심링크 덕분에 기존 시그니처 그대로
     };
 }
```

---

## 1.3 `src/commands.js` — CLI 목록 + 모델 목록

### 변경 1: `DEFAULT_CLI_CHOICES` (L10)

```diff
-const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode'];
+const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode', 'copilot'];
```

### 변경 2: `MODEL_CHOICES_BY_CLI` (L11-22)

```diff
     opencode: [
         'anthropic/claude-opus-4-6-thinking', ...
     ],
+    copilot: [
+        'claude-sonnet-4.6', 'claude-opus-4.6', 'claude-haiku-4.5',
+        'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex',
+        'gpt-4.1', 'gpt-5-mini',
+        'gemini-3-pro-preview',
+    ],
 };
```

### 변경 3: `fallbackAllowed` (L312)

```diff
-const fallbackAllowed = allowed.length ? allowed : ['claude', 'codex', 'gemini', 'opencode'];
+const fallbackAllowed = allowed.length ? allowed : DEFAULT_CLI_CHOICES;
```

### 변경 4: `versionHandler` (L416)

```diff
-for (const key of ['claude', 'codex', 'gemini', 'opencode']) {
+for (const key of DEFAULT_CLI_CHOICES) {
```

---

## 1.4 `public/index.html` — CLI 선택 + 모델 옵션

### 변경 1: CLI 선택 드롭다운 (L86-89)

```diff
 <option value="claude">Claude</option>
 <option value="codex">Codex</option>
 <option value="gemini">Gemini</option>
 <option value="opencode">OpenCode</option>
+<option value="copilot">Copilot</option>
```

### 변경 2: 모델 선택 블록 추가 (L210 이후)

```html
<!-- Copilot models -->
<div id="modelGroupCopilot" class="model-group" style="display:none">
    <label>Copilot Model</label>
    <select id="modelCopilot">
        <option selected>claude-sonnet-4.6</option>
        <option>claude-opus-4.6</option>
        <option>claude-haiku-4.5</option>
        <option>gpt-5.3-codex</option>
        <option>gpt-5.2-codex</option>
        <option>gpt-4.1</option>
        <option>gpt-5-mini</option>
        <option>gemini-3-pro-preview</option>
    </select>
    <label>Effort</label>
    <select id="effortCopilot">
        <option value="">default</option>
    </select>
</div>
```

---

## 1.5 `public/js/features/settings.js` — perCli 저장

### 변경: L141-144

```diff
 claude: { model: getModelValue('claude'), effort: document.getElementById('effortClaude').value },
 codex: { model: getModelValue('codex'), effort: document.getElementById('effortCodex').value },
+copilot: { model: getModelValue('copilot'), effort: document.getElementById('effortCopilot')?.value || '' },
 opencode: { model: getModelValue('opencode'), effort: document.getElementById('effortOpencode').value },
```

---

## 1.6 `public/js/features/employees.js` — 직원 UI

### 변경: L48

```diff
-${['claude', 'codex', 'gemini', 'opencode'].map(c => ...
+${['claude', 'codex', 'gemini', 'opencode', 'copilot'].map(c => ...
```

---

## 1.7 `lib/mcp-sync.js` — Copilot MCP 동기화

### 변경: `syncToAll()` 내부 (기존 Claude/Codex/Gemini 동기화 이후)

```js
// 4. Copilot: ~/.copilot/mcp-config.json
try {
    const copilotPath = join(os.homedir(), '.copilot', 'mcp-config.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(copilotPath, 'utf8')); } catch { }
    existing.mcpServers = claudeData.mcpServers; // Claude와 동일 포맷 확인 필요
    fs.mkdirSync(dirname(copilotPath), { recursive: true });
    fs.writeFileSync(copilotPath, JSON.stringify(existing, null, 4) + '\n');
    results.copilot = true;
    console.log(`[mcp-sync] ✅ Copilot: ${copilotPath}`);
} catch (e) { console.error(`[mcp-sync] ❌ Copilot:`, e.message); }
```

---

## Phase 1 테스트

```bash
# 1. postinstall 실행
cd ~/Documents/BlogProject/cli-claw && npm run postinstall

# 2. copilot PATH 확인
which copilot
copilot --version

# 3. cli-claw 서버 재시작 후 확인
# 웹 UI에서 CLI 드롭다운에 Copilot 표시
# /cli copilot 전환 가능
# /model → copilot 모델 목록 표시
# /version → copilot 버전 표시

# 4. MCP sync 확인
cat ~/.copilot/mcp-config.json
```
