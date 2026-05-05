#!/usr/bin/env node
// @file scripts/check-strict-baseline.mjs
// Strict-migration regression gate (AST-aware).
//
// Per R2.2 (devlog/_plan/strict-migration/07-pro-review-r2.md), this scanner
// uses the TypeScript Compiler API to walk source files and count AST nodes
// of kind `AnyKeyword` plus any-typed `TypeReference` (Array<any>, Promise<any>,
// Record<string, any>, etc.). Comments and string literals are automatically
// ignored because they are not type-position AST nodes.
//
// Two markers per R2.2.1:
//   @strict-debt(P##)        — temporary, must be cleared by phase P##
//   @strict-allow-any(<reason>) — permanently allowed, counted separately
//
// Reads docs/migration/strict-baseline.md for frozen counts and exits 1 if
// any tracked directory's live count exceeds the baseline.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = process.env.STRICT_BASELINE_ROOT || fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = join(REPO_ROOT, 'docs/migration/strict-baseline.md');

const TRACKED_DIRS = ['src', 'bin', 'lib', 'public/js', 'public/manager/src', 'scripts', 'server.ts', 'types'];
const STRICT_DEBT_SCAN_PATHS = ['src', 'bin', 'lib', 'scripts', 'server.ts', 'public', 'types'];
const EXCLUDE_DIR_NAMES = new Set([
    'node_modules', 'dist', 'build', '.git', 'coverage', '__snapshots__',
]);

function isTypeScriptFile(file) {
    return file.endsWith('.ts') || file.endsWith('.tsx');
}

function* walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (e.isFile() && isTypeScriptFile(full)) yield full;
    }
}

function* filesForPath(absPath) {
    let stat;
    try { stat = statSync(absPath); } catch { return; }
    if (stat.isDirectory()) {
        yield* walk(absPath);
        return;
    }
    if (stat.isFile() && isTypeScriptFile(absPath)) yield absPath;
}

const ANY_TYPE_REF_NAMES = new Set([
    'Array', 'Promise', 'Record', 'ReadonlyArray', 'Map', 'Set', 'Partial',
    'Required', 'Readonly', 'Pick', 'Omit', 'ReadonlyMap', 'ReadonlySet',
]);

function isAnyKeyword(node) {
    return ts.isToken(node) && node.kind === ts.SyntaxKind.AnyKeyword;
}

// Detect type reference whose own type-arguments include `any`, e.g. Record<string, any>.
function typeArgsContainAny(node) {
    if (!ts.isTypeReferenceNode(node)) return false;
    const args = node.typeArguments;
    if (!args || args.length === 0) return false;
    return args.some((a) => a.kind === ts.SyntaxKind.AnyKeyword);
}

function leadingMarkerOnLine(src, pos) {
    // Look back to the start of the line that contains `pos`, then look at
    // the lines immediately before for `// @strict-debt(...)` or
    // `// @strict-allow-any(...)`. Allow up to 3 lines of preceding context.
    const before = src.slice(0, pos);
    const idx = before.lastIndexOf('\n');
    const lineStart = idx + 1;
    const lineText = src.slice(lineStart, src.indexOf('\n', pos) >= 0 ? src.indexOf('\n', pos) : src.length);

    if (/@strict-(debt|allow-any)\b/.test(lineText)) {
        return /@strict-debt\b/.test(lineText) ? 'debt' : 'allow';
    }

    // check up to 3 lines above (whitespace-only between also fine)
    let cursor = lineStart;
    for (let i = 0; i < 3; i++) {
        if (cursor <= 0) break;
        const prevEnd = cursor - 1;
        const prevStart = src.lastIndexOf('\n', prevEnd - 1) + 1;
        const prev = src.slice(prevStart, prevEnd);
        if (/@strict-debt\b/.test(prev)) return 'debt';
        if (/@strict-allow-any\b/.test(prev)) return 'allow';
        if (prev.trim() !== '' && !/^\s*\/\//.test(prev)) break;
        cursor = prevStart;
    }
    return null;
}

function scanText(src, filename = 'inline.ts') {
    const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let any = 0;
    let debt = 0;
    let allow = 0;
    function visit(node) {
        if (isAnyKeyword(node)) {
            const marker = leadingMarkerOnLine(src, node.getStart(sf));
            if (marker === 'debt') debt++;
            else if (marker === 'allow') allow++;
            else any++;
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return { any, debt, allow };
}

function scanFile(file) {
    const src = readFileSync(file, 'utf8');
    return scanText(src, file);
}

function countDir(absDir) {
    const result = { any: 0, debt: 0, allow: 0 };
    for (const file of filesForPath(absDir)) {
        const r = scanFile(file);
        result.any += r.any;
        result.debt += r.debt;
        result.allow += r.allow;
    }
    return result;
}

function findStrictDebtMarkers(absDir) {
    const hits = [];
    for (const file of filesForPath(absDir)) {
        const src = readFileSync(file, 'utf8');
        const lines = src.split(/\r?\n/);
        lines.forEach((line, idx) => {
            if (line.includes('@strict-debt')) hits.push(`${file}:${idx + 1}`);
        });
    }
    return hits;
}

function runTypecheck(args) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(npx, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0,
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    };
}

function parseBaseline(text) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s+any-shapes baseline\b/i.test(l));
    if (start < 0) throw new Error('baseline section "## any-shapes baseline" not found');
    const out = {};
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('## ')) break;
        if (!line.startsWith('|')) continue;
        if (/^\|[\s\-:|]+\|$/.test(line)) continue;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length !== 4) continue;
        if (cells[0].toLowerCase() === 'dir') continue;
        const [dir, any, debt, allow] = cells;
        out[dir] = { any: Number(any), debt: Number(debt), allow: Number(allow) };
    }
    if (Object.keys(out).length === 0) {
        throw new Error('baseline table parsed empty — check column count and separator');
    }
    return out;
}

function fmt(dir, c) { return `| ${dir} | ${c.any} | ${c.debt} | ${c.allow} |`; }

function main() {
    const baselineText = readFileSync(BASELINE_PATH, 'utf8');
    const baseline = parseBaseline(baselineText);

    const live = {};
    for (const dir of TRACKED_DIRS) live[dir] = countDir(join(REPO_ROOT, dir));

    const regressions = [];
    const debtMarkerHits = [];
    for (const dir of TRACKED_DIRS) {
        const b = baseline[dir];
        const l = live[dir];
        if (!b) { regressions.push(`baseline missing for tracked dir "${dir}"`); continue; }
        if (l.any > b.any) regressions.push(`${dir}.any: live=${l.any} > baseline=${b.any} (+${l.any - b.any})`);
        if (l.debt > b.debt) regressions.push(`${dir}.debt: live=${l.debt} > baseline=${b.debt} (+${l.debt - b.debt})`);
        // allow can grow — permanent contracts; only flag if doc forbids
    }
    for (const path of STRICT_DEBT_SCAN_PATHS) {
        debtMarkerHits.push(...findStrictDebtMarkers(join(REPO_ROOT, path)));
    }
    if (debtMarkerHits.length > 0) {
        regressions.push(`@strict-debt markers are forbidden post-P20: ${debtMarkerHits.join(', ')}`);
    }

    const header = '| dir | any | debt | allow |';
    const sep    = '|-----|----:|-----:|------:|';
    console.log('## strict-baseline live snapshot');
    console.log(header); console.log(sep);
    for (const dir of TRACKED_DIRS) console.log(fmt(dir, live[dir]));
    console.log('');
    console.log('## strict-baseline baseline (frozen)');
    console.log(header); console.log(sep);
    for (const dir of TRACKED_DIRS) {
        const b = baseline[dir] ?? { any: '—', debt: '—', allow: '—' };
        console.log(fmt(dir, b));
    }
    console.log('');

    console.log('## strict-baseline typecheck gates');
    const rootTypecheck = runTypecheck(['tsc', '--noEmit']);
    console.log(`root: ${rootTypecheck.ok ? 'ok' : `fail (${rootTypecheck.status ?? 'unknown'})`}`);
    if (!rootTypecheck.ok) regressions.push(`root typecheck failed:\n${rootTypecheck.output}`);
    const frontendTypecheck = runTypecheck(['tsc', '--noEmit', '-p', 'tsconfig.frontend.json']);
    console.log(`frontend: ${frontendTypecheck.ok ? 'ok' : `fail (${frontendTypecheck.status ?? 'unknown'})`}`);
    if (!frontendTypecheck.ok) regressions.push(`frontend typecheck failed:\n${frontendTypecheck.output}`);
    console.log('');

    if (regressions.length > 0) {
        console.error('❌ strict-baseline regression detected:');
        for (const r of regressions) console.error('  - ' + r);
        console.error('');
        console.error('If this regression is intentional (a phase plan accepted it),');
        console.error('lower the baseline in docs/migration/strict-baseline.md in the SAME PR.');
        console.error('To temporarily exempt a single occurrence, annotate it with one of:');
        console.error('  // @strict-debt(P##)        — must be cleared by phase P##');
        console.error('  // @strict-allow-any(<reason>) — permanent contract');
        process.exit(1);
    }
    console.log('✅ strict-baseline OK (no regressions in tracked directories).');
}

// Run as CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

// Exported for unit tests (R2.2.2). Not part of CLI surface.
export { scanFile, scanText, parseBaseline, countDir, TRACKED_DIRS };
