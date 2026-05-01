#!/usr/bin/env node
const { execSync } = require('node:child_process');
const NATIVE = ['better-sqlite3', 'playwright-core', 'sharp', 'canvas'];
const pat = NATIVE.join('|');
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
  console.error('❌ Native dep imports detected in electron/src:\n' + matches);
  process.exit(1);
}
console.log('✅ Electron source has no native deps');
