#!/usr/bin/env node
/**
 * Phase 22 named release gates for cli-jaw.
 *
 * Each gate has a NAME, a CHECK function, and prints PASS / FAIL.
 * Usage:
 *   node scripts/release-gates.mjs              # run all gates
 *   node scripts/release-gates.mjs <gate-name>  # run one gate
 *
 * Wired through package.json as `gate:<name>`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditClaims, formatClaimAuditReport } from './claim-audit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, {
        cwd: repoRoot,
        stdio: opts.stdio || 'pipe',
        encoding: 'utf8',
        ...opts,
    });
}

function readFile(rel) {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

const FORBIDDEN_IN_READY = [
    /external[-\s]?cdp/i,
    /remote[-\s]?cdp/i,
    /hosted browser/i,
    /browser_type_ref/,
    /browser_navigate/,
    /browser_screenshot/,
    /browser_back/,
    /browser_forward/,
    /browser_reload/,
    /browser_wait_for/,
    /browser_extract_text/,
];

const GATES = {
    'typecheck': {
        description: 'tsc --noEmit (server + frontend) clean',
        check() {
            const tasks = ['typecheck', 'typecheck:frontend'];
            for (const t of tasks) {
                const r = run('npm', ['run', t, '--silent']);
                if (r.status !== 0) {
                    return { ok: false, detail: `${t} failed:\n${(r.stderr || r.stdout || '').slice(-2000)}` };
                }
            }
            return { ok: true, detail: `tsc clean for: ${tasks.join(', ')}` };
        },
    },
    'tests': {
        description: 'browser web-ai unit tests pass (mirror parity)',
        check() {
            const targets = [
                'tests/unit/browser-web-ai-target-resolver.test.ts',
                'tests/unit/browser-web-ai-answer-artifact.test.ts',
                'tests/unit/browser-web-ai-source-audit.test.ts',
                'tests/unit/browser-web-ai-cli-contract.test.ts',
                'tests/unit/release-gates.test.ts',
            ].filter((p) => fs.existsSync(path.join(repoRoot, p)));
            if (targets.length === 0) {
                return { ok: false, detail: 'no Phase 22 mirror tests found' };
            }
            const args = [
                'tsx', '--import', './tests/setup/test-home.ts',
                '--experimental-test-module-mocks', '--test',
                ...targets,
            ];
            const r = run('npx', args);
            if (r.status !== 0) {
                return { ok: false, detail: `tests failed:\n${(r.stdout || r.stderr || '').slice(-2000)}` };
            }
            return { ok: true, detail: `passed ${targets.length} suite(s): ${targets.join(', ')}` };
        },
    },
    'truth-table-fresh': {
        description: 'CAPABILITY_TRUTH_TABLE.md edited within 7 days OR matches code refs',
        check() {
            const rel = 'structure/CAPABILITY_TRUTH_TABLE.md';
            const abs = path.join(repoRoot, rel);
            if (!fs.existsSync(abs)) return { ok: false, detail: `${rel} missing` };
            const stat = fs.statSync(abs);
            const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays <= 7) return { ok: true, detail: `truth table ${ageDays.toFixed(2)}d old` };
            const text = readFile(rel);
            const required = ['action-intent', 'target-resolver', 'answer-artifact', 'source-audit'];
            for (const term of required) {
                if (!text.includes(term)) {
                    return { ok: false, detail: `truth table stale (${ageDays.toFixed(1)}d) and missing ${term}` };
                }
            }
            return { ok: true, detail: `truth table ${ageDays.toFixed(1)}d old but matches required terms` };
        },
    },
    'mcp-scope-frozen': {
        description: 'cli-jaw exposes no browser MCP tool surface (agbrowse owns 2 frozen tools)',
        check() {
            // cli-jaw must NOT register browser_* MCP tools — agbrowse is the
            // sole source. Scan src/ for any new declarative MCP tool entries
            // named browser_*.
            const offenders = [];
            const srcDir = path.join(repoRoot, 'src');
            const stack = [srcDir];
            while (stack.length) {
                const dir = stack.pop();
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(full);
                        continue;
                    }
                    if (!/\.(ts|mts|mjs|js|cjs)$/.test(entry.name)) continue;
                    const text = fs.readFileSync(full, 'utf8');
                    // any hint of a registered MCP browser_* tool definition
                    if (/['"]browser_(snapshot|click_ref|type_ref|navigate|back|forward|reload|wait_for|screenshot|extract_text)['"]\s*:\s*{/.test(text)) {
                        offenders.push(path.relative(repoRoot, full));
                    }
                }
            }
            if (offenders.length > 0) {
                return { ok: false, detail: `cli-jaw must not register browser MCP tools; offenders:\n${offenders.join('\n')}` };
            }
            return { ok: true, detail: 'cli-jaw registers no browser MCP tools (agbrowse owns the frozen scope)' };
        },
    },
    'no-experimental-in-readme-ready-section': {
        description: 'README "ready" claims do not include external CDP or unimplemented MCP tools',
        check() {
            const files = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md', 'structure/CAPABILITY_TRUTH_TABLE.md']
                .filter((p) => fs.existsSync(path.join(repoRoot, p)));
            const offending = [];
            for (const rel of files) {
                const text = readFile(rel);
                const sections = text.split(/\n##\s+/);
                for (const sec of sections) {
                    const head = sec.split('\n', 1)[0].toLowerCase();
                    const isReady = head.includes('ready') || head.includes('production') || head.includes('supported') || head.includes('feature');
                    const isExperimentalSection = head.includes('experimental') || head.includes('deferred') || head.includes('out of scope') || head.includes('forbidden') || head.includes('mirror rules');
                    if (!isReady || isExperimentalSection) continue;
                    for (const pat of FORBIDDEN_IN_READY) {
                        if (pat.test(sec)) {
                            offending.push(`${rel} :: ${head} :: ${pat}`);
                        }
                    }
                }
            }
            if (offending.length > 0) {
                return { ok: false, detail: `forbidden terms in ready sections:\n${offending.join('\n')}` };
            }
            return { ok: true, detail: `${files.length} README/truth-table file(s) clean of experimental terms in ready sections` };
        },
    },
    'no-cloud-claims': {
        description: 'no hosted/cloud/stealth/external-CDP/leaderboard claims outside experimental sections (G10 mirror)',
        check() {
            const report = auditClaims({ repoRoot });
            return { ok: report.ok, detail: formatClaimAuditReport(report) };
        },
    },
    'observe-actions-fixtures': {
        description: 'observe-actions module loads and produces ranked candidates from a fixture snapshot (G02 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = path.resolve(repoRoot, 'node_modules/.bin/tsx');
                const fixtureScript = `import { buildObserveActions, formatObserveActions } from '${path.resolve(repoRoot, 'src/browser/web-ai/observe-actions.ts').replace(/\\\\/g, '/')}';\nconst r = buildObserveActions({ snapshotId: 'gate-fixture', url: null, refs: { '@e1': { role: 'button', name: 'Sign in' }, '@e2': { role: 'textbox', name: 'Email' }, '@e3': { role: 'link', name: 'Forgot password?' } } }, 'click sign in');\nif (!r || !Array.isArray(r.candidates) || r.candidates.length < 3) { console.error('candidates<3'); process.exit(2); }\nif (r.candidates[0].ref !== '@e1' || r.candidates[0].action !== 'click') { console.error('rank-fail'); process.exit(3); }\nif (!r.candidates.every(c => c.args.snapshotId === 'gate-fixture')) { console.error('snapId-missing'); process.exit(4); }\nconst t = formatObserveActions(r); if (!t || typeof t !== 'string') { console.error('format-fail'); process.exit(5); }\nconsole.log('OK ' + r.candidates.length);`;
                const res = spawnSync(tsxBin, ['--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `observe-actions fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `observe-actions fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `observe-actions fixture threw: ${(err && err.message) || err}` };
            }
        },
    },
    'observation-bundle-fixtures': {
        description: 'observation-bundle module emits ObservationBundleV1 from a fixture (G06 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = path.resolve(repoRoot, 'node_modules/.bin/tsx');
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/observation-bundle.ts').replace(/\\\\/g, '/');
                const fixtureScript = `import { buildObservationBundle, OBSERVATION_BUNDLE_SCHEMA_VERSION } from '${modPath}';\nconst b = buildObservationBundle({ url: 'https://x.test/', viewport: { width: 800, height: 600 }, snapshotNodes: [{ ref: '@e1', role: 'button', name: 'Go' }, { ref: '...', role: 'note', name: 't' }], boxes: { '@e1': { x: 1, y: 2, width: 10, height: 20 } }, textSummary: 'hello' });\nif (b.schemaVersion !== OBSERVATION_BUNDLE_SCHEMA_VERSION) { console.error('schema-mismatch'); process.exit(2); }\nif (b.refs.length !== 1) { console.error('ref-filter-fail'); process.exit(3); }\nif (!b.refs[0].box || b.refs[0].box.width !== 10) { console.error('box-attach-fail'); process.exit(4); }\nif (b.stats.refCount !== 1 || b.stats.boxCount !== 1 || b.stats.textChars !== 5) { console.error('stats-fail'); process.exit(5); }\nconsole.log('OK refs=' + b.stats.refCount + ' boxes=' + b.stats.boxCount + ' text=' + b.stats.textChars + 'ch');`;
                const res = spawnSync(tsxBin, ['--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `observation-bundle fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `observation-bundle fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `observation-bundle fixture threw: ${(err && err.message) || err}` };
            }
        },
    },
    'browser-primitives-catalog': {
        description: 'action-breadth catalog exposes the agreed primitive set (G03 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = path.resolve(repoRoot, 'node_modules/.bin/tsx');
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/action-breadth.ts').replace(/\\\\/g, '/');
                const fixtureScript = `import { BROWSER_PRIMITIVES, listPrimitiveCommands, BROWSER_PRIMITIVE_SCHEMA_VERSION, auditPrimitiveCoverage } from '${modPath}';\nif (BROWSER_PRIMITIVE_SCHEMA_VERSION !== 'browser-primitives-v1') { console.error('schema-mismatch'); process.exit(2); }\nif (BROWSER_PRIMITIVES.length < 18) { console.error('too-few'); process.exit(3); }\nconst cmds = new Set(listPrimitiveCommands());\nfor (const c of ['select','check','uncheck','upload','drag','scroll','wait-for']) { if (!cmds.has(c)) { console.error('missing:'+c); process.exit(4); } }\nconst fake = [...BROWSER_PRIMITIVES].map(p => 'case ' + JSON.stringify(p.command) + ':').join('\\n');\nconst r = auditPrimitiveCoverage(fake);\nif (!r.ok || r.missing.length !== 0) { console.error('audit-fail'); process.exit(5); }\nconsole.log('OK ' + BROWSER_PRIMITIVES.length + ' primitives');`;
                const res = spawnSync(tsxBin, ['--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `action-breadth fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `action-breadth fixture: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `action-breadth gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'action-memory-safe-replay': {
        description: 'action-memory cache returns hit only when DOM signature matches (G07 mirror)',
        async check() {
            try {
                const { spawnSync } = await import('node:child_process');
                const path = await import('node:path');
                const tsxBin = path.resolve(repoRoot, 'node_modules/.bin/tsx');
                const modPath = path.resolve(repoRoot, 'src/browser/web-ai/action-memory.ts').replace(/\\\\/g, '/');
                const fixtureScript = `import { createActionMemory, validateMemoryHit, ACTION_MEMORY_SCHEMA_VERSION } from '${modPath}';\nif (ACTION_MEMORY_SCHEMA_VERSION !== 'action-memory-v1') { console.error('schema-mismatch'); process.exit(2); }\nconst m = createActionMemory();\nm.put({ origin: 'https://x.test', intentId: 'i', signature: 'sig-A', ref: '@e1', hits: 0, validations: { ok: 0, fail: 0 }, lastGoodAt: '' });\nconst hit = m.get('https://x.test', 'i', 'sig-A');\nif (!hit || hit.ref !== '@e1') { console.error('miss-on-match'); process.exit(3); }\nif (m.get('https://x.test', 'i', 'sig-B') !== null) { console.error('hit-on-drift'); process.exit(4); }\nif (validateMemoryHit(hit, 'sig-B') !== null) { console.error('validate-allowed-drift'); process.exit(5); }\nm.clear();\nif (m.size() !== 0) { console.error('clear-failed'); process.exit(6); }\nconsole.log('OK hit-on-match miss-on-drift clear');`;
                const res = spawnSync(tsxBin, ['--eval', fixtureScript], { encoding: 'utf8' });
                if (res.status !== 0) {
                    return { ok: false, detail: `action-memory fixture failed: status=${res.status} stderr=${(res.stderr || '').trim()} stdout=${(res.stdout || '').trim()}` };
                }
                return { ok: true, detail: `action-memory: ${(res.stdout || '').trim()}` };
            } catch (err) {
                return { ok: false, detail: `action-memory gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'model-adapter-frozen': {
        description: 'G09 mirror: cli-jaw must not implement an API model adapter or claim parity (negative-parity)',
        async check() {
            try {
                // Truth-table must declare the deferred (frozen) row.
                const truth = readFile('structure/CAPABILITY_TRUTH_TABLE.md');
                const g09Line = truth.match(/^[^\n]*G09[^\n]+model[- ]adapter[^\n]+/im)?.[0] || '';
                if (!g09Line) {
                    return { ok: false, detail: 'CAPABILITY_TRUTH_TABLE.md missing G09 model-adapter row' };
                }
                if (!/(deferred|frozen)/i.test(g09Line)) {
                    return { ok: false, detail: `G09 row must be marked deferred/frozen, got: ${g09Line.slice(0, 200)}` };
                }

                // package.json must NOT depend on provider SDKs.
                const pkg = JSON.parse(readFile('package.json'));
                const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
                const sdkDenylist = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', 'ai'];
                for (const name of Object.keys(allDeps)) {
                    if (sdkDenylist.includes(name) || name.startsWith('@ai-sdk/')) {
                        return { ok: false, detail: `forbidden provider SDK dep: ${name}` };
                    }
                }

                // Source scan limited to browser/web-ai surface (cli-jaw's
                // broader memory/quota system has unrelated OpenAI integration
                // that pre-dates and is independent of the agbrowse G09 freeze).
                const scanRoots = ['src/browser'];
                /** @type {Array<{file:string, hit:string}>} */
                const violations = [];
                const cmdAliasRe = /\b(api-query|model-query|--api\b|--transport\s+api|--mode\s+api)\b/;
                const envRe = /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|MODEL_ADAPTER_[A-Z_]+|AI_SDK_[A-Z_]+)\b/;
                const importRe = /from\s+['"](openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|@ai-sdk\/[^'"]+|ai)['"]/;
                const dirDenylist = ['src/browser/web-ai/model-adapter', 'src/model-adapter', 'src/api-client'];
                for (const dirRel of dirDenylist) {
                    if (fs.existsSync(path.join(repoRoot, dirRel))) {
                        return { ok: false, detail: `forbidden path exists: ${dirRel}/` };
                    }
                }
                /** @param {string} dirAbs */
                function walk(dirAbs) {
                    if (!fs.existsSync(dirAbs)) return;
                    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                        const abs = path.join(dirAbs, entry.name);
                        if (entry.isDirectory()) { walk(abs); continue; }
                        if (!/\.(mjs|cjs|js|ts|tsx|json|md)$/.test(entry.name)) continue;
                        const rel = path.relative(repoRoot, abs);
                        if (rel.endsWith('release-gates.mjs')) continue;
                        if (rel.endsWith('CAPABILITY_TRUTH_TABLE.md')) continue;
                        const text = fs.readFileSync(abs, 'utf8');
                        if (cmdAliasRe.test(text)) violations.push({ file: rel, hit: 'forbidden api-query/--api/--transport api alias' });
                        if (envRe.test(text)) violations.push({ file: rel, hit: 'forbidden API key/MODEL_ADAPTER_/AI_SDK_ env var' });
                        if (importRe.test(text)) violations.push({ file: rel, hit: 'forbidden provider SDK import' });
                    }
                }
                for (const root of scanRoots) walk(path.join(repoRoot, root));
                if (violations.length) {
                    const sample = violations.slice(0, 5).map(v => `${v.file}: ${v.hit}`).join('; ');
                    return { ok: false, detail: `${violations.length} negative-parity violation(s): ${sample}` };
                }

                return { ok: true, detail: 'cli-jaw mirror clean: deferred row present, no SDK deps, no api-* drift' };
            } catch (err) {
                return { ok: false, detail: `model-adapter-frozen mirror gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'workflow-common-layer-no-sdk': {
        description: 'Workflow/goal/goal-run/team/frontend must not import provider SDKs or create model adapter paths',
        async check() {
            try {
                const scanRoots = [
                    'src/workflows',
                    'src/goal',
                    'src/goal-run',
                    'src/team',
                    'public/js',
                ];
                const importRe = /from\s+['"](openai|@openai\/agents|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|@ai-sdk\/[^'"]+|ai)['"]/;
                const envRe = /\b(MODEL_ADAPTER_[A-Z_]+|AI_SDK_[A-Z_]+)\b/;
                /** @type {Array<{file:string, hit:string}>} */
                const violations = [];
                /** @param {string} dirAbs */
                function walk(dirAbs) {
                    if (!fs.existsSync(dirAbs)) return;
                    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                        const abs = path.join(dirAbs, entry.name);
                        if (entry.isDirectory()) { walk(abs); continue; }
                        if (!/\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) continue;
                        const rel = path.relative(repoRoot, abs);
                        if (rel.endsWith('release-gates.mjs')) continue;
                        const text = fs.readFileSync(abs, 'utf8');
                        if (importRe.test(text)) violations.push({ file: rel, hit: 'forbidden provider SDK import' });
                        if (envRe.test(text)) violations.push({ file: rel, hit: 'forbidden MODEL_ADAPTER_/AI_SDK_ env var' });
                    }
                }
                for (const root of scanRoots) walk(path.join(repoRoot, root));
                const dirDenylist = [
                    'src/workflows/model-adapter',
                    'src/goal/model-adapter',
                    'src/goal-run/model-adapter',
                    'src/team/model-adapter',
                ];
                for (const dirRel of dirDenylist) {
                    if (fs.existsSync(path.join(repoRoot, dirRel))) {
                        violations.push({ file: dirRel, hit: 'forbidden model-adapter path' });
                    }
                }
                if (violations.length) {
                    const sample = violations.slice(0, 5).map(v => `${v.file}: ${v.hit}`).join('; ');
                    return { ok: false, detail: `${violations.length} violation(s): ${sample}` };
                }
                return { ok: true, detail: 'workflow common layer clean: no SDK imports, no model-adapter paths' };
            } catch (err) {
                return { ok: false, detail: `workflow-common-layer-no-sdk gate threw: ${(err && err.message) || err}` };
            }
        },
    },
    'doc-drift': {
        description: 'structure docs match live inventory (docs:check TS extractors + legacy bash checks)',
        check() {
            // CI runners produce platform-dependent file/line inventories
            // (no public/dist, different tracked-file set) that this gate
            // cannot reconcile; it stays a local/pre-release discipline gate.
            if (process.env.CI) {
                return { ok: true, detail: 'skipped on CI (local/pre-release gate only)' };
            }
            const steps = [
                { name: 'docs:check', cmd: 'npm', args: ['run', 'docs:check', '--silent'], timeout: 120_000 },
                { name: 'check-doc-drift.sh', cmd: 'bash', args: ['structure/check-doc-drift.sh'], timeout: 120_000 },
            ];
            for (const s of steps) {
                const r = run(s.cmd, s.args, { timeout: s.timeout });
                if (r.status !== 0) {
                    return { ok: false, detail: `${s.name} failed:\n${(r.stdout || r.stderr || '').slice(-1500)}` };
                }
            }
            return { ok: true, detail: 'docs:check + check-doc-drift.sh clean' };
        },
    },
    'strict-baseline': {
        description: 'any-count ratchet: live counts must not exceed docs/migration/strict-baseline.md',
        check() {
            const r = run('node', ['scripts/check-strict-baseline.mjs'], { timeout: 120_000 });
            if (r.status !== 0) {
                return { ok: false, detail: `strict baseline regressed:\n${(r.stdout || r.stderr || '').slice(-1200)}` };
            }
            return { ok: true, detail: 'live any/debt/allow counts within frozen baseline' };
        },
    },
    'redaction-sinks': {
        description: 'channel replies, sends and loggers route through a credential masker',
        check() {
            const r = run('node', ['scripts/check-redaction-sinks.mjs'], { timeout: 60_000 });
            if (r.status !== 0) {
                return { ok: false, detail: `unmasked channel sink:\n${(r.stdout || r.stderr || '').slice(-1500)}` };
            }
            return { ok: true, detail: 'no unmasked sink in telegram/discord/slack/telegram-hub' };
        },
    },
};

function printResult(name, result) {
    const status = result.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[${status}] gate:${name} — ${GATES[name].description}\n`);
    if (result.detail) process.stdout.write(`        ${result.detail.replace(/\n/g, '\n        ')}\n`);
}

async function main() {
    const target = process.argv[2];
    const names = target ? [target] : Object.keys(GATES);
    let failed = 0;
    for (const name of names) {
        if (!GATES[name]) {
            process.stdout.write(`[FAIL] gate:${name} — unknown gate\n`);
            failed += 1;
            continue;
        }
        let result;
        try {
            result = await GATES[name].check();
        } catch (err) {
            result = { ok: false, detail: `threw: ${err.message}` };
        }
        printResult(name, result);
        if (!result.ok) failed += 1;
    }
    process.stdout.write(failed === 0 ? `\nAll ${names.length} gate(s) passed.\n` : `\n${failed}/${names.length} gate(s) FAILED.\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    process.stderr.write(`release-gates threw: ${err.stack || err}\n`);
    process.exit(1);
});
