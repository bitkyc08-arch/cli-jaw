# PATCH-3: Postinstall & Config — Cross-Platform

**Files**: `bin/postinstall.ts`, `src/core/config.ts`
**Priority**: 🟡 Medium (install may fail on non-macOS)

---

## 1. `src/core/config.ts` — Replace `which` with cross-platform detection

### Current (lines 195-201)
```typescript
export function detectCli(name: string) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { available: false, path: null };
    try {
        const p = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
        return { available: true, path: p };
    } catch { /* expected: CLI binary may not be installed */ return { available: false, path: null }; }
}
```

### Proposed Diff
```diff
 export function detectCli(name: string) {
     if (!/^[a-z0-9_-]+$/i.test(name)) return { available: false, path: null };
     try {
-        const p = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
+        const cmd = process.platform === 'win32' ? 'where' : 'which';
+        const p = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 }).trim();
+        // `where` on Windows may return multiple lines; take the first
+        const firstLine = p.split('\n')[0].trim();
-        return { available: true, path: p };
+        return { available: true, path: firstLine };
     } catch { /* expected: CLI binary may not be installed */ return { available: false, path: null }; }
 }
```

### Notes
- Windows `where` returns all matches (one per line); take the first
- `which` on Linux/macOS returns single path — `split('\n')[0]` is harmless
- WSL uses Linux `which` — no change needed

---

## 2. `bin/postinstall.ts` — Replace `which` calls

### Current (line 95)
```typescript
execSync(`which ${bin}`, { stdio: 'pipe' });
```

### Proposed Diff
```diff
-execSync(`which ${bin}`, { stdio: 'pipe' });
+const whichCmd = process.platform === 'win32' ? 'where' : 'which';
+execSync(`${whichCmd} ${bin}`, { stdio: 'pipe' });
```

### Notes
- Extract `whichCmd` as a file-level constant (used in multiple places)
- Place near top of file: `const WHICH = process.platform === 'win32' ? 'where' : 'which';`
- Replace all `which` references in the file with `WHICH`

---

## 3. `bin/postinstall.ts` — `uv` install cross-platform

### Current (lines 191-197)
```typescript
const SKILL_DEPS = [
    {
        name: 'uv',
        check: 'uv --version',
        install: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
    },
```

### Proposed Diff
```diff
 const SKILL_DEPS = [
     {
         name: 'uv',
         check: 'uv --version',
-        install: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
+        install: process.platform === 'win32'
+            ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
+            : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
         why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
     },
```

### Notes
- `uv` officially provides a PowerShell install script for Windows
- `curl | sh` works on Linux/macOS/WSL — no change needed there
- The `check` (`uv --version`) is cross-platform — no change

---

## 4. `bin/postinstall.ts` — Symlink fallback

### Current (lines 44-50)
```typescript
function ensureSymlink(target: string, linkPath: string) {
    if (fs.existsSync(linkPath)) return false;
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath);
    console.log(`[jaw:init] symlink: ${linkPath} → ${target}`);
    return true;
}
```

### Proposed Diff
```diff
 function ensureSymlink(target: string, linkPath: string) {
     if (fs.existsSync(linkPath)) return false;
     fs.mkdirSync(path.dirname(linkPath), { recursive: true });
-    fs.symlinkSync(target, linkPath);
-    console.log(`[jaw:init] symlink: ${linkPath} → ${target}`);
-    return true;
+    try {
+        fs.symlinkSync(target, linkPath);
+        console.log(`[jaw:init] symlink: ${linkPath} → ${target}`);
+        return true;
+    } catch (err: any) {
+        if (process.platform === 'win32' && err.code === 'EPERM') {
+            // Windows without Developer Mode: fall back to junction (dirs) or copy (files)
+            try {
+                const stat = fs.statSync(target);
+                if (stat.isDirectory()) {
+                    fs.symlinkSync(target, linkPath, 'junction');
+                } else {
+                    fs.copyFileSync(target, linkPath);
+                }
+                console.log(`[jaw:init] fallback link: ${linkPath} → ${target}`);
+                return true;
+            } catch { /* fall through */ }
+        }
+        console.error(`[jaw:init] ⚠️  symlink failed: ${linkPath} — ${err.message}`);
+        return false;
+    }
 }
```

### Notes
- `EPERM` on Windows = no symlink permission (needs Developer Mode or admin)
- Junctions work for directories without admin on Windows
- File copy as last resort — functional but won't auto-update
- On Linux/macOS: symlink always works, no fallback needed
- Never crash postinstall — graceful degradation with warning
