#!/usr/bin/env node
/*
 * Run sweep/enumerate/axe gates against the fixture harness instead of the
 * live app. The live Jaw may have no online instances (every row offline is
 * the common case), and panels with `needsSession` cannot open there at all
 * — a sweep that cannot reach its surface is not a sweep. The harness pins
 * the production decoders, so the panels measured here are the real ones.
 *
 * Usage:
 *   node scripts/qa/fixture-sweep.mjs --surface notes --mode interact --out evidence/x.json
 *   node scripts/qa/fixture-sweep.mjs --surface notes --tool enumerate --out evidence/x.json
 *   node scripts/qa/fixture-sweep.mjs --surface notes --tool axe --out evidence/x.json
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};
const surface = flag('surface');
const mode = flag('mode', 'interact');
const tool = flag('tool', 'sweep');
const out = flag('out');

if (!surface || !out) {
    console.error('Usage: fixture-sweep.mjs --surface <name> [--mode interact|keyboard] [--tool sweep|enumerate|axe] --out <path>');
    process.exit(2);
}

const command = {
    sweep: ['scripts/qa/sweep.mjs', '--surface', surface, '--mode', mode, '--fixture', '--out', out],
    enumerate: ['scripts/qa/enumerate-interactives.mjs', '--surface', surface, '--fixture', '--out', out],
    axe: ['scripts/qa/axe-scan.mjs', '--surface', surface, '--fixture', '--out', out],
}[tool];
if (!command) {
    console.error(`Unknown tool "${tool}"`);
    process.exit(2);
}

const child = spawn(process.execPath, command, { stdio: 'inherit' });
const exitCode = await new Promise((resolvePromise) => child.on('exit', resolvePromise));
process.exit(exitCode ?? 1);
