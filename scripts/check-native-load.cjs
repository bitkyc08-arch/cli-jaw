#!/usr/bin/env node
/**
 * Runtime load probe for shipped native addons (260803 unit, 040 phase D1).
 *
 * Static grep proves a module is imported. It does not prove the binary loads.
 * The v2.2.10 incident made that concrete: the dashboard returned HTTP 200
 * while the Telegram bot could not resolve a pruned dependency. Presence is
 * not liveness.
 *
 * node-pty@1.1.0 is N-API based (node-addon-api, 38 napi_ symbols, zero v8/Nan),
 * so a NODE_MODULE_VERSION mismatch is NOT the risk here. What can still break
 * is architecture, asarUnpack placement, and the executable bit on
 * `spawn-helper` — none of which a grep can see. So we dlopen the binary and,
 * where possible, actually run a pty.
 *
 * Usage:
 *   node scripts/check-native-load.cjs                      # check the repo tree
 *   node scripts/check-native-load.cjs --app <path/to.app>   # check a packaged app
 */
const { existsSync, statSync, readdirSync, constants, accessSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const appIndex = args.indexOf('--app');
const appPath = appIndex >= 0 ? args[appIndex + 1] : null;

const failures = [];
const notes = [];

function fail(message) { failures.push(message); }
function note(message) { notes.push(message); }

function findPtyRoot() {
  if (appPath) {
    // electron-builder unpacks asarUnpack entries next to the asar.
    const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
    if (existsSync(unpacked)) return unpacked;
    const plain = join(appPath, 'Contents', 'Resources', 'app', 'node_modules', 'node-pty');
    if (existsSync(plain)) return plain;
    return null;
  }
  const local = join(process.cwd(), 'electron', 'node_modules', 'node-pty');
  return existsSync(local) ? local : null;
}

const ptyRoot = findPtyRoot();
// Exit 3 = nothing was probed. The caller must not present this as a pass;
// a green "loads fine" when nothing loaded is the exact dishonesty this
// script exists to remove.
const EXIT_SKIPPED = 3;
if (!ptyRoot) {
  if (appPath) {
    fail(`node-pty not found in ${appPath}. asarUnpack must keep it outside the asar (electron-builder.yml asarUnpack: node_modules/node-pty/**/*); a packed addon cannot be dlopen'd.`);
  } else if (process.env.JAW_GATE_REQUIRE_NATIVE === '1') {
    // Opt-in requirement rather than a blanket CI check. The node-tests
    // workflow runs `npm ci --ignore-scripts` at the root only, so it never
    // has electron/node_modules at all: keying on CI made this gate demand an
    // artifact that context cannot produce, and every PR went red for it.
    // The flag is set where the artifact really exists (desktop-release, right
    // after `npm ci --prefix electron`), so a miss there is a genuine failure.
    fail('electron/node_modules/node-pty is absent but JAW_GATE_REQUIRE_NATIVE=1 demanded a real probe (run npm i in electron/)');
  } else {
    console.log('ℹ node-pty not installed in electron/node_modules — nothing probed (run npm i in electron/)');
    process.exit(EXIT_SKIPPED);
  }
} else {
  const binary = join(ptyRoot, 'build', 'Release', 'pty.node');
  if (!existsSync(binary)) {
    fail(`missing native binary: ${binary}`);
  } else {
    // 1. The binary must actually dlopen under this runtime.
    try {
      const handle = { exports: {} };
      process.dlopen(handle, binary, constants.dlopen?.RTLD_NOW ?? undefined);
      note(`dlopen ok: ${binary}`);
    } catch (error) {
      fail(`dlopen failed for ${binary}: ${(error && error.message) || error}`);
    }

    // 2. spawn-helper must be present AND executable, or every pty dies at
    //    runtime with a permission error that no import check would catch.
    const helper = join(ptyRoot, 'build', 'Release', 'spawn-helper');
    if (process.platform !== 'win32') {
      if (!existsSync(helper)) {
        fail(`missing spawn-helper: ${helper}`);
      } else {
        try {
          accessSync(helper, constants.X_OK);
          note(`spawn-helper executable: mode ${(statSync(helper).mode & 0o777).toString(8)}`);
        } catch {
          fail(`spawn-helper is not executable: ${helper} (mode ${(statSync(helper).mode & 0o777).toString(8)})`);
        }
      }
    }

    // 3. Architecture must match the host, or dlopen succeeds nowhere useful.
    try {
      const prebuilds = join(ptyRoot, 'prebuilds');
      if (existsSync(prebuilds)) {
        note(`prebuilds present: ${readdirSync(prebuilds).join(', ')}`);
      }
    } catch { /* informational only */ }

    // 4. Actually spawn a pty and read from it. access(X_OK) says the bit is
    //    set; it does not say codesign, quarantine, or arch let the helper run.
    //    Only a real spawn covers that, and it is the failure a user would hit
    //    on their first terminal session in the shipped app.
    if (!appPath) {
      // Run the round-trip in a child so we can wait on it without blocking
      // this process's event loop — pty data arrives via callbacks, so a
      // synchronous wait here would guarantee a false negative.
      const probe = `
        const pty = require(${JSON.stringify(ptyRoot)});
        // cmd.exe does not understand POSIX -c; it needs /c (with /d /s to skip
        // AutoRun and keep quote handling predictable). Passing -c made the
        // shell exit non-zero and print usage, so the probe would have reported
        // a broken spawn-helper on Windows even when the addon was healthy.
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWin ? ['/d', '/s', '/c', 'echo jaw-pty-ok'] : ['-c', 'echo jaw-pty-ok'];
        const term = pty.spawn(shell, shellArgs, {
          name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
        });
        let seen = '';
        const done = (code) => { try { term.kill(); } catch {} process.exit(code); };
        term.onData((chunk) => { seen += chunk; if (seen.includes('jaw-pty-ok')) done(0); });
        setTimeout(() => done(seen.includes('jaw-pty-ok') ? 0 : 7), 5000);
      `;
      try {
        execFileSync(process.execPath, ['-e', probe], { timeout: 15_000, stdio: 'ignore' });
        note('pty spawn round-trip ok (spawn-helper genuinely executes)');
      } catch (error) {
        const status = error && error.status;
        if (status === 7) {
          fail('pty spawned but produced no output within 5s — spawn-helper may be blocked by codesign/quarantine');
        } else {
          // The child's message embeds the whole probe source; keep only the
          // first meaningful line so the build log stays readable.
          const raw = String((error && error.message) || error);
          const firstLine = raw.split('\n').find(l => /Error|EACCES|EPERM|ENOENT/.test(l)) || raw.split('\n')[0];
          fail(`pty spawn failed: ${firstLine.trim()}`);
        }
      }
    } else {
      note('packaged app: spawn round-trip skipped (needs the Electron runtime); dlopen + permissions checked');
    }
  }
}

for (const line of notes) console.log(`   ${line}`);
if (failures.length > 0) {
  console.error('❌ native load probe failed:');
  for (const line of failures) console.error(`   - ${line}`);
  process.exit(1);
}
console.log(`✅ native addons load${appPath ? ` in ${appPath}` : ''}`);
