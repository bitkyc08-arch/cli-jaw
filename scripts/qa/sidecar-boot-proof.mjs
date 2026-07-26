#!/usr/bin/env node
// wp8 — does the packaged sidecar actually boot, and does its telegram path
// resolve hermetically (inside the sidecar only)?
//
// The original crash: ERR_MODULE_NOT_FOUND for node-fetch in
// dist/src/telegram/bot.js. A dependency-closure check resolves into a parent
// node_modules and calls that a pass; this proof runs INSIDE the sidecar with
// NODE_PATH cleared, so a missing package is a real failure.
//
// Two proofs:
//   1. bin/jaw serve boots and answers health.
//   2. telegram/bot.js resolves its imports from the sidecar's own
//      node_modules, with no escape to the repo parent.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// realpath: on macOS /tmp is a symlink to /private/tmp, and the resolved
// package path comes back through the real path, so the comparison must too.
const SIDECAR = realpathSync(resolve(process.argv[2] ?? 'electron/sidecar/server'));
const NODE = process.execPath;

if (!existsSync(join(SIDECAR, 'dist/src/telegram/bot.js'))) {
    console.error(`[sidecar-boot-proof] no sidecar at ${SIDECAR} — run scripts/bundle-sidecar.sh first`);
    process.exit(2);
}

// Proof 1: telegram import resolution, hermetic. cwd is the sidecar so
// node_modules resolution starts there, and NODE_PATH is cleared so it cannot
// escape to the repo parent.
// Hermetic: the telegram import must resolve node-fetch from the SIDECAR's
// own node_modules, not the repo parent. cwd + cleared NODE_PATH is not
// enough — Node still walks up to the repo root. So we assert the RESOLVED
// path of node-fetch stays under the sidecar.
const tg = spawnSync(
    NODE,
    ['--input-type=module', '-e',
     `import { createRequire } from 'node:module';
      const req = createRequire('file://${join(SIDECAR, 'dist/src/telegram/bot.js')}');
      const sidecarRoot = '${SIDECAR}';
      try {
        const resolved = req.resolve('node-fetch');
        if (!resolved.startsWith(sidecarRoot)) {
          console.error('tg-fail: node-fetch resolves OUTSIDE the sidecar at ' + resolved);
          process.exit(1);
        }
        console.log('tg-ok: node-fetch resolves inside the sidecar');
      } catch (e) {
        console.error('tg-fail: node-fetch does not resolve: ' + e.message.split('\\n')[0]);
        process.exit(1);
      }`],
    { cwd: SIDECAR, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 },
);
process.stdout.write(tg.stdout ?? '');
process.stderr.write(tg.stderr ?? '');
if (tg.status !== 0) {
    console.error('[sidecar-boot-proof] FAIL: telegram path does not resolve hermetically');
    process.exit(1);
}

// Resolving node-fetch is necessary but not sufficient: the module itself
// must LOAD. The original crash was a top-level import of bot.js, so import it.
const tgLoad = spawnSync(
    NODE,
    ['--input-type=module', '-e',
     `import('file://${join(SIDECAR, 'dist/src/telegram/bot.js')}').then(
        () => console.log('tg-load-ok: telegram/bot.js loads'),
        (e) => { console.error('tg-load-fail: ' + e.message.split('\\n')[0]); process.exit(1); }
      );`],
    { cwd: SIDECAR, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 },
);
process.stdout.write(tgLoad.stdout ?? '');
process.stderr.write(tgLoad.stderr ?? '');
if (tgLoad.status !== 0) {
    console.error('[sidecar-boot-proof] FAIL: telegram path does not resolve hermetically');
    process.exit(1);
}
console.log('[sidecar-boot-proof] telegram path resolves hermetically');

// Proof 2: bin/jaw serve boots and answers health.
const home = mkdtempSync(join(tmpdir(), 'jaw-sidecar-home-'));
const port = 34500 + Math.floor(Math.random() * 500);
// The shim is a SHELL script (bundle-sidecar.sh:180) that execs
// `node dist/bin/cli-jaw.js`. Run it directly, not as JS to node.
const server = spawn(join(SIDECAR, 'bin/jaw'), ['--home', home, 'serve', '--port', String(port), '--no-open'], {
    cwd: SIDECAR,
    env: { PATH: process.env.PATH, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = false;
const deadline = Date.now() + 45000;
server.stderr?.on('data', (d) => process.stderr.write(d));
while (Date.now() < deadline && !booted) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) booted = true;
    } catch { /* not up yet */ }
}
server.kill('SIGTERM');
if (!booted) {
    console.error('[sidecar-boot-proof] FAIL: bin/jaw serve did not answer health within 45s');
    process.exit(1);
}
console.log('[sidecar-boot-proof] OK: bin/jaw serve boots and answers health');
