#!/usr/bin/env node
// ─── Offline Dependency Check ────────────────────────
// Phase 9.7 — package-lock.json 기반 오프라인 취약 버전 검증
// 네트워크 없이도 알려진 advisory 범위와 비교 가능

import fs from 'node:fs';
import path from 'node:path';

const lockPath = path.resolve('package-lock.json');
if (!fs.existsSync(lockPath)) {
    console.error('[deps] package-lock.json not found');
    process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const pkgs = lock.packages || {};

function ver(p) { return pkgs[p]?.version || null; }

function semver(v) {
    const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function lt(a, b) {
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
    return false;
}

function gte(a, b) { return !lt(a, b); }

function inRange(v, lo, hi) {
    const sv = semver(v);
    return sv && gte(sv, semver(lo)) && lt(sv, semver(hi));
}

// ─── Advisory Rules ──────────────────────────────────
const rules = [
    {
        pkg: 'node_modules/ws',
        test: v => inRange(v, '8.0.0', '8.17.1'),
        adv: 'GHSA-3h5v-q93c-6h6q',
        why: 'DoS via infinite loop',
    },
    {
        pkg: 'node_modules/node-fetch',
        test: v => inRange(v, '3.0.0', '3.1.1') || lt(semver(v), semver('2.6.7')),
        adv: 'GHSA-r683-j2x4-v87g',
        why: 'header forwarding to third-party',
    },
    {
        pkg: 'node_modules/grammy/node_modules/node-fetch',
        test: v => lt(semver(v), semver('2.6.7')),
        adv: 'GHSA-r683-j2x4-v87g',
        why: 'transitive dependency',
    },
];

// ─── Check ───────────────────────────────────────────
let fail = 0;
for (const r of rules) {
    const v = ver(r.pkg);
    if (!v) {
        console.log(`SKIP ${r.pkg} (not installed)`);
        continue;
    }
    if (r.test(v)) {
        fail++;
        console.error(`FAIL ${r.pkg}@${v} → ${r.adv} (${r.why})`);
    } else {
        console.log(`PASS ${r.pkg}@${v}`);
    }
}

process.exit(fail > 0 ? 1 : 0);
