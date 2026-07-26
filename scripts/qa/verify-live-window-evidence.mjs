#!/usr/bin/env node
// wplive — validate the evidence a Computer Use pass leaves behind.
//
// Computer Use is not something a Node script can call. It is an agent-run
// step, so the script's job is not to collect the window's state but to check
// that whoever did collect it left a complete, self-consistent record — and to
// hand the runner the one value it cannot discover on its own: which origin
// the Electron renderer is actually attached to.
//
// That matters because the two verifiers can silently look at different apps.
// A Chrome tab on :24576 and an Electron window on :24577 are different manager
// processes, and comparing them produces "disagreements" that are nothing of
// the kind.
//
// Usage: node scripts/qa/verify-live-window-evidence.mjs <evidence.json>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = process.argv[2];
if (!path) {
    console.error('usage: verify-live-window-evidence.mjs <evidence.json>');
    process.exit(2);
}

let evidence;
try {
    evidence = JSON.parse(readFileSync(resolve(path), 'utf8'));
} catch (error) {
    console.error(`[wplive] cannot read ${path}: ${error.message}`);
    process.exit(2);
}

/**
 * What the OS/Computer Use side must record.
 *
 * `windowPid` is collected here and nowhere else — the runner cannot see the
 * native process — so it is required but never cross-checked. Everything else
 * the runner re-measures independently.
 */
const REQUIRED = {
    rendererOrigin: (v) => typeof v === 'string' && /^https?:\/\/[^/]+$/.test(v),
    windowPid: (v) => Number.isInteger(v) && v > 0,
    managerPid: (v) => Number.isInteger(v) && v > 0,
    managerPort: (v) => Number.isInteger(v) && v > 0,
    instanceSnapshotHash: (v) => typeof v === 'string' && v.length >= 8,
    buildIdentity: (v) => typeof v === 'string' && v.length > 0,
    timestamp: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
};

const problems = [];
for (const [key, ok] of Object.entries(REQUIRED)) {
    if (!(key in evidence)) { problems.push(`missing: ${key}`); continue; }
    if (!ok(evidence[key])) problems.push(`malformed: ${key} = ${JSON.stringify(evidence[key])}`);
}

// The origin and the port have to agree with each other, or the runner will be
// pointed at one manager while the identity claims another.
if (typeof evidence.rendererOrigin === 'string' && Number.isInteger(evidence.managerPort)) {
    let originPort = null;
    try { originPort = Number(new URL(evidence.rendererOrigin).port); } catch { /* reported above */ }
    if (originPort && originPort !== evidence.managerPort) {
        problems.push(`rendererOrigin port ${originPort} does not match managerPort ${evidence.managerPort}`);
    }
}

// Stale evidence is worse than none: the app may have restarted since.
const MAX_AGE_MS = 15 * 60 * 1000;
if (typeof evidence.timestamp === 'string' && !Number.isNaN(Date.parse(evidence.timestamp))) {
    const age = Date.now() - Date.parse(evidence.timestamp);
    if (age > MAX_AGE_MS) {
        problems.push(`evidence is ${Math.round(age / 60000)} minutes old (max ${MAX_AGE_MS / 60000})`);
    }
}

if (problems.length) {
    console.error(`[wplive] evidence at ${path} is not usable:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nCollect it again with Computer Use. The runner needs rendererOrigin,');
    console.error('and the identity fields are what make the cross-check a cross-check.');
    process.exit(1);
}

console.error(`[wplive] evidence OK — renderer ${evidence.rendererOrigin},`
    + ` manager pid ${evidence.managerPid} on ${evidence.managerPort}`);
// The runner is invoked with this. Print it alone on stdout so it can be
// captured directly.
console.log(evidence.rendererOrigin);
