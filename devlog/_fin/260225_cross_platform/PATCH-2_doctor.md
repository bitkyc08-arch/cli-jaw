# PATCH-2: Doctor — Cross-Platform Checks

**File**: `bin/commands/doctor.ts`
**Priority**: 🟠 High (doctor reports incomplete on Linux/WSL)

---

## 1. Chrome Detection — Expand beyond macOS

### Current (lines 137-143)
```typescript
if (process.platform === 'darwin') {
    check('Google Chrome', () => {
        if (fs.existsSync('/Applications/Google Chrome.app')) return 'installed';
        if (fs.existsSync(path.join(os.homedir(), 'Applications/Google Chrome.app'))) return 'installed (user)';
        throw new Error('WARN: not found — required for browser skill');
    });
}
```

### Proposed Diff
```diff
-if (process.platform === 'darwin') {
-    check('Google Chrome', () => {
-        if (fs.existsSync('/Applications/Google Chrome.app')) return 'installed';
-        if (fs.existsSync(path.join(os.homedir(), 'Applications/Google Chrome.app'))) return 'installed (user)';
-        throw new Error('WARN: not found — required for browser skill');
-    });
-}
+check('Google Chrome', () => {
+    const platform = process.platform;
+    if (platform === 'darwin') {
+        if (fs.existsSync('/Applications/Google Chrome.app')) return 'installed';
+        if (fs.existsSync(path.join(os.homedir(), 'Applications/Google Chrome.app'))) return 'installed (user)';
+    } else if (platform === 'win32') {
+        const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
+        if (fs.existsSync(`${pf}\\Google\\Chrome\\Application\\chrome.exe`)) return 'installed';
+    } else {
+        // Linux / WSL
+        const linuxPaths = [
+            '/usr/bin/google-chrome-stable',
+            '/usr/bin/google-chrome',
+            '/usr/bin/chromium-browser',
+            '/usr/bin/chromium',
+            '/snap/bin/chromium',
+        ];
+        for (const p of linuxPaths) {
+            if (fs.existsSync(p)) return 'installed';
+        }
+    }
+    throw new Error('WARN: not found — required for browser skill');
+});
```

### Notes
- Remove platform guard entirely — run check on ALL platforms
- Same path list as PATCH-1 `findChrome()` for consistency
- Consider extracting shared `CHROME_PATHS` constant to avoid duplication (optional, can do later)

---

## 2. Accessibility Check — Platform-Specific Messaging

### Current (lines 101-116)
```typescript
if (process.platform === 'darwin') {
    check('macOS Accessibility', () => {
        try {
            execSync('osascript -e "tell application \\"System Events\\" to return name of first process"', {
                stdio: 'pipe', timeout: 5000,
            });
            return 'granted';
        } catch {
            try {
                execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { stdio: 'pipe' });
            } catch { }
            throw new Error('WARN: 접근성 권한 필요 → 시스템 설정을 열었습니다. Terminal을 추가해주세요');
        }
    });
}
```

### Proposed Diff
```diff
 if (process.platform === 'darwin') {
     check('macOS Accessibility', () => {
         try {
             execSync('osascript -e "tell application \\"System Events\\" to return name of first process"', {
                 stdio: 'pipe', timeout: 5000,
             });
             return 'granted';
         } catch {
             try {
                 execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { stdio: 'pipe' });
             } catch { }
             throw new Error('WARN: 접근성 권한 필요 → 시스템 설정을 열었습니다. Terminal을 추가해주세요');
         }
     });
 }
+
+if (process.platform === 'linux') {
+    check('Display Server', () => {
+        if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return process.env.WAYLAND_DISPLAY ? 'Wayland' : `X11 (${process.env.DISPLAY})`;
+        // WSL2 with WSLg sets DISPLAY automatically
+        try {
+            const ver = fs.readFileSync('/proc/version', 'utf8');
+            if (ver.toLowerCase().includes('microsoft')) return 'WSL (headless OK — use --no-sandbox)';
+        } catch { /* not WSL */ }
+        throw new Error('WARN: no DISPLAY — browser skill needs a display server or WSLg');
+    });
+}
```

### Notes
- Keep macOS Accessibility check as-is (already guarded)
- Add Linux-specific "Display Server" check — critical for browser skill
- WSL2 with WSLg: `DISPLAY` is set automatically, so this will pass
- WSL1 / headless VMs: warn user that browser skill needs a display
- No equivalent check needed for Windows (always has a display)
