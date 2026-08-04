#!/usr/bin/env node
const { execSync } = require('node:child_process');

// Split, because a single list encoded a false invariant. node-pty IS a native
// addon, IS an electron dependency, and IS imported by the terminal module —
// so "electron source has no native deps" was simply untrue, and the one addon
// that actually ships was the one nothing checked.
//
// FORBIDDEN: must never appear in electron/src. Any of these would drag a
// second native build into the Electron ABI.
const FORBIDDEN = ['better-sqlite3', 'playwright-core', 'sharp', 'canvas'];
// EXPECTED_NATIVE: legitimately shipped. Presence here is not a failure, but it
// IS a promise that a runtime load probe covers it — see check-native-load.cjs.
const EXPECTED_NATIVE = ['node-pty'];
const pat = FORBIDDEN.join('|');
// Match any of:
//   from "pkg" / from 'pkg'
//   require("pkg") / require('pkg')
//   import("pkg") / import('pkg')
const regex = `(from|require|import)[[:space:]]*\\(?[[:space:]]*['\\\"](${pat})['\\\"]`;
let out = '';
try {
  out = execSync(`grep -rEn "${regex}" electron/src/ || true`, { encoding: 'utf8' });
} catch (e) { out = ''; }
const matches = out.trim();
if (matches) {
  console.error('❌ Forbidden native dep imports detected in electron/src:\n' + matches);
  process.exit(1);
}

// A bare-specifier grep only sees the first hop. electron/src already reaches
// across the tree boundary with relative paths (electron/src/main/lib/folder/ipc.ts
// imports into src/manager/git/*), and src/manager/reminders/store.ts imports
// better-sqlite3 — so the guard is one careless import away from being wrong
// while still printing a pass. Follow the relative graph transitively.
const { existsSync, readFileSync } = require('node:fs');
const { dirname, resolve, join } = require('node:path');

function resolveModule(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const candidate of [
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
    join(base, 'index.ts'), join(base, 'index.tsx'),
    `${base}.js`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `sharp` and `sharp/lib/x.js` are the same dependency. */
function isForbidden(spec) {
  return FORBIDDEN.some(pkg => spec === pkg || spec.startsWith(`${pkg}/`));
}

function crawl(entryFiles) {
  const seen = new Set();
  const queue = [...entryFiles];
  const violations = [];
  let unresolved = 0;
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let source = '';
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    // Covers `from 'x'`, `require('x')`, `import('x')`, and the bare
    // side-effect form `import 'x';` — the last one is easy to miss and is
    // exactly how an unnoticed dependency creeps in.
    const specRe = /(?:from|require\(|import\(|^\s*import)\s*['"]([^'"]+)['"]/gm;
    let match;
    while ((match = specRe.exec(source)) !== null) {
      const spec = match[1];
      if (isForbidden(spec)) {
        violations.push(`${file}: imports ${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const resolved = resolveModule(spec, file);
      if (resolved) queue.push(resolved);
      // A silently dropped specifier is a hole in the crawl that looks
      // identical to a clean result, so count and report them.
      else unresolved += 1;
    }
  }
  return { violations, scanned: seen.size, unresolved };
}

let entries = [];
try {
  entries = execSync('find electron/src -name "*.ts" -o -name "*.tsx"', { encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean).map(f => resolve(f));
} catch { entries = []; }

const { violations, scanned, unresolved } = crawl(entries);
if (violations.length > 0) {
  console.error('❌ Forbidden native dep reachable from electron/src via relative imports:');
  for (const line of violations) console.error(`   - ${line}`);
  console.error('\nThese would need an Electron-ABI rebuild; the sidecar builds for Node.');
  process.exit(1);
}
// Known limit, stated rather than implied: computed specifiers
// (`import(`../${name}.js`)`) and `createRequire(...)('pkg')` are invisible to
// a text scan — the same blind spot the sidecar prune guard documents.
console.log(`✅ Electron source has no forbidden native deps (scanned ${scanned} files transitively${unresolved ? `, ${unresolved} relative specifiers unresolved` : ''}; expected native: ${EXPECTED_NATIVE.join(', ')})`);
