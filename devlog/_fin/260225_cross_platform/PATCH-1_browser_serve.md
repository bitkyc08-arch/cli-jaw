# PATCH-1: Browser Launch & Serve — Cross-Platform

**Files**: `src/browser/connection.ts`, `bin/commands/serve.ts`
**Priority**: 🔴 Critical (browser skill completely broken on non-macOS)

---

## 1. `src/browser/connection.ts` — `findChrome()`

### Current (macOS-only)
```typescript
// lines 11-20
function findChrome() {
    const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    for (const p of paths) {
        try { execSync(`test -f "${p}"`, { stdio: 'pipe' }); return p; } catch { }
    }
    throw new Error('Chrome not found — install Google Chrome');
}
```

### Proposed Diff
```diff
 function findChrome() {
-    const paths = [
-        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
-        '/Applications/Chromium.app/Contents/MacOS/Chromium',
-        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
-    ];
-    for (const p of paths) {
-        try { execSync(`test -f "${p}"`, { stdio: 'pipe' }); return p; } catch { }
-    }
-    throw new Error('Chrome not found — install Google Chrome');
+    const platform = process.platform;
+    const paths: string[] = [];
+
+    if (platform === 'darwin') {
+        paths.push(
+            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
+            '/Applications/Chromium.app/Contents/MacOS/Chromium',
+            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
+        );
+    } else if (platform === 'win32') {
+        const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
+        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
+        const local = process.env.LOCALAPPDATA || '';
+        paths.push(
+            `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
+            `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
+            `${local}\\Google\\Chrome\\Application\\chrome.exe`,
+            `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
+        );
+    } else {
+        // Linux / WSL
+        paths.push(
+            '/usr/bin/google-chrome-stable',
+            '/usr/bin/google-chrome',
+            '/usr/bin/chromium-browser',
+            '/usr/bin/chromium',
+            '/snap/bin/chromium',
+        );
+        // WSL: try Windows Chrome via /mnt/c
+        if (isWSL()) {
+            paths.push(
+                '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
+                '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
+            );
+        }
+    }
+
+    for (const p of paths) {
+        try {
+            fs.accessSync(p, fs.constants.X_OK);
+            return p;
+        } catch { /* next */ }
+    }
+    throw new Error('Chrome not found — install Google Chrome');
 }
```

### New helper needed (top of file):
```typescript
import fs from 'node:fs';

function isWSL(): boolean {
    if (process.platform !== 'linux') return false;
    try {
        return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch { return false; }
}
```

### Notes
- Replace `execSync('test -f ...')` with `fs.accessSync()` — pure Node, no shell spawn
- WSL detection via `/proc/version` containing "microsoft" (standard method)
- `X_OK` flag checks execute permission, not just existence

---

## 2. `bin/commands/serve.ts` — `open` command

### Current (macOS-only)
```typescript
// lines 79-86
if (values.open) {
    setTimeout(() => {
        exec(`open ${getServerUrl(values.port as string)}`, (err) => {
            if (err) console.log('  ⚠️ Could not open browser');
        });
    }, 2000);
}
```

### Proposed Diff
```diff
 if (values.open) {
     setTimeout(() => {
-        exec(`open ${getServerUrl(values.port as string)}`, (err) => {
+        const url = getServerUrl(values.port as string);
+        const cmd = process.platform === 'darwin' ? 'open'
+                  : process.platform === 'win32'  ? 'start'
+                  : 'xdg-open';
+        exec(`${cmd} ${url}`, (err) => {
             if (err) console.log('  ⚠️ Could not open browser');
         });
     }, 2000);
 }
```

### Notes
- `xdg-open` is standard on most Linux desktops (including WSL2 with WSLg)
- `start` is Windows native
- If `xdg-open` is missing on headless Linux, the error is already caught and logged
- WSL1 without WSLg: `xdg-open` won't work, but the warning message handles it gracefully
