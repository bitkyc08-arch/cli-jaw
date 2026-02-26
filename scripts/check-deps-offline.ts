#!/usr/bin/env node
// ─── Offline Dependency Check ────────────────────────
// Phase 9.7 — package-lock.json 기반 오프라인 취약 버전 검증
// 네트워크 없이도 알려진 advisory 범위와 비교 가능

import fs from 'node:fs';
import path from 'node:path';

type SemVer = [number, number, number];

interface PackageLock {
    packages?: Record<string, { version?: string }>;
}

interface Rule {
    pkg: string;
    test: (v: string) => boolean;
    adv: string;
    why: string;
}

const lockPath = path.resolve('package-lock.json');
if (!fs.existsSync(lockPath)) {
    console.error('[deps] package-lock.json not found');
    process.exit(2);
}

const lock: PackageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const pkgs = lock.packages ?? {};

function ver(p: string): string | null { return pkgs[p]?.version ?? null; }

function semver(v: string | null): SemVer | null {
    const m = String(v ?? '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1]!, +m[2]!, +m[3]!] as SemVer : null;
}

function lt(a: SemVer, b: SemVer): boolean {
    for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! < b[i]!; }
    return false;
}

function gte(a: SemVer, b: SemVer): boolean { return !lt(a, b); }

function inRange(v: string, lo: string, hi: string): boolean {
    const sv = semver(v);
    const loSv = semver(lo);
    const hiSv = semver(hi);
    return sv !== null && loSv !== null && hiSv !== null && gte(sv, loSv) && lt(sv, hiSv);
}

// ─── Advisory Rules ──────────────────────────────────
const rules: Rule[] = [
    {
        pkg: 'node_modules/ws',
        test: (v: string) => inRange(v, '8.0.0', '8.17.1'),
        adv: 'GHSA-3h5v-q93c-6h6q',
        why: 'DoS via infinite loop',
    },
    {
        pkg: 'node_modules/node-fetch',
        test: (v: string) => {
            const sv = semver(v);
            const target = semver('2.6.7');
            return inRange(v, '3.0.0', '3.1.1') || (sv !== null && target !== null && lt(sv, target));
        },
        adv: 'GHSA-r683-j2x4-v87g',
        why: 'header forwarding to third-party',
    },
    {
        pkg: 'node_modules/grammy/node_modules/node-fetch',
        test: (v: string) => {
            const sv = semver(v);
            const target = semver('2.6.7');
            return sv !== null && target !== null && lt(sv, target);
        },
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
