#!/usr/bin/env node
/*
 * E4 gate: interaction p95 under 100ms.
 *
 * Protocol is fixed in 011_acceptance_matrix.md so two reviewers measuring the
 * same surface get the same number:
 *   start  = immediately after the user event is dispatched
 *   end    = first rAF after the completion predicate becomes true
 *   sample = 5 warmup discarded, then 50 measured; p95 from those 50
 *   repeat = 3 rounds, take the MEDIAN p95
 *
 * Each interaction must be repeatable: its reset has to put the DOM back so the
 * predicate is false again before the next sample. An interaction whose
 * predicate is already true at sample start measures ~0 and is worthless, which
 * is why reset assertions are part of the definition rather than an afterthought.
 *
 * Usage:
 *   node scripts/qa/perf.mjs --surface sidebar --out evidence/wp2.perf.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { launch } from './qa-lib.mjs';
import { startFixtureServer, openFixture } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const surfaceName = flag('surface');
const outPath = flag('out');
const url = flag('url', 'http://127.0.0.1:24577/dashboard2/');
const threshold = Number(flag('threshold', '100'));

const WARMUP = 5;
const SAMPLES = 50;
const ROUNDS = 3;

/**
 * The three named sidebar interactions, per 040_wp2_sidebar.md.
 *
 * `precondition` must return true or the interaction is BLOCKED — it is never
 * silently dropped, because 011 requires all three to pass.
 */
const INTERACTIONS = {
    sidebar: [
        {
            id: 'sidebar.toggle',
            precondition: () => Boolean(document.querySelector('.d2-sidebar-toggle')),
            trigger: () => document.querySelector('.d2-sidebar-toggle')?.click()
                ?? document.querySelector('.d2-workbench-side-toggle-open')?.click(),
            done: () => Boolean(document.querySelector('.d2-shell.d2-sb-closed'))
                && Boolean(document.querySelector('.d2-workbench-side-toggle-open')),
            reset: () => document.querySelector('.d2-workbench-side-toggle-open')?.click(),
            resetDone: () => !document.querySelector('.d2-shell.d2-sb-closed'),
        },
        {
            id: 'sidebar.mode',
            precondition: () => document.querySelectorAll('.d2-mode-button').length >= 2,
            trigger: () => document.querySelectorAll('.d2-mode-button')[1]?.click(),
            done: () => document.querySelectorAll('.d2-mode-button')[1]?.getAttribute('aria-selected') === 'true',
            reset: () => document.querySelectorAll('.d2-mode-button')[0]?.click(),
            resetDone: () => document.querySelectorAll('.d2-mode-button')[0]?.getAttribute('aria-selected') === 'true',
        },
        {
            id: 'sidebar.instance-expand',
            // Needs an ONLINE instance with MULTIPLE sessions: a single-session
            // instance never renders the list, so the predicate could not fire.
            precondition: () => Boolean(document.querySelector('.d2-instance-main:not([disabled])')),
            trigger: () => document.querySelector('.d2-instance-main:not([disabled])')?.click(),
            done: () => Boolean(document.querySelector('.d2-session-row')),
            reset: () => document.querySelector('.d2-instance-main:not([disabled])')?.click(),
            resetDone: () => !document.querySelector('.d2-session-row'),
        },
    ],
};

if (!surfaceName || !outPath || !INTERACTIONS[surfaceName]) {
    console.error('Usage: perf.mjs --surface <name> --out <path> [--url <url>] [--threshold <ms>]');
    console.error(`Known surfaces: ${Object.keys(INTERACTIONS).join(', ')}`);
    process.exit(2);
}

const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
};
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// E4 needs an online instance with MULTIPLE sessions, which the live app may
// not have. `--fixture` runs against the harness with a multi-session sidebar
// preseed instead, so the interaction can actually fire.
const useFixture = args.includes('--fixture');
let browser, page, fixtureServer;
if (useFixture) {
    fixtureServer = await startFixtureServer();
    ({ browser, page } = await openFixture(fixtureServer.url, {
        historyCount: 10,
        initScript: (cfg) => { window.__jawE2EPreseed = { sidebar: cfg }; },
        initScriptArg: {
            instances: [{ port: 3506, label: 'wp10 perf multi', status: 'online', version: 'e2e', workingDir: '/tmp/wp4-e2e' }],
            chatSessions: { 3506: { sessions: [
                { id: 'sess-p1', seq: 1, label: 'wp10 perf one', created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z', message_count: 3 },
                { id: 'sess-p2', seq: 2, label: 'wp10 perf two', created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z', message_count: 5 },
            ], active: 'sess-p1' } },
        },
    }));
} else {
    ({ browser, page } = await launch(url));
}
const results = [];

try {
    for (const interaction of INTERACTIONS[surfaceName]) {
        const spec = {
            precondition: interaction.precondition.toString(),
            trigger: interaction.trigger.toString(),
            done: interaction.done.toString(),
            reset: interaction.reset.toString(),
            resetDone: interaction.resetDone.toString(),
        };

        const ok = await page.evaluate((src) => {
            // eslint-disable-next-line no-new-func
            return Boolean(new Function(`return (${src})`)()());
        }, spec.precondition);

        if (!ok) {
            results.push({
                id: interaction.id,
                verdict: 'blocked',
                reason: 'fixture precondition not met (needs an online instance with multiple sessions for instance-expand)',
            });
            console.error(`${interaction.id}: BLOCKED — precondition not met`);
            continue;
        }

        const roundP95s = [];
        let roundSamples = [];
        for (let round = 0; round < ROUNDS; round += 1) {
            const durations = await page.evaluate(async ({ src, warmup, samples }) => {
                const make = (source) => new Function(`return (${source})`)();
                const trigger = make(src.trigger);
                const done = make(src.done);
                const reset = make(src.reset);
                const resetDone = make(src.resetDone);

                const settle = (predicate, budgetMs = 2000) => new Promise((resolve, rejectWith) => {
                    const started = performance.now();
                    const tick = () => {
                        if (predicate()) { resolve(performance.now()); return; }
                        if (performance.now() - started > budgetMs) { rejectWith(new Error('predicate timeout')); return; }
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                });

                const measured = [];
                for (let i = 0; i < warmup + samples; i += 1) {
                    // Guarantee a false predicate before every sample.
                    if (done()) { reset(); await settle(resetDone).catch(() => {}); }
                    const start = performance.now();
                    trigger();
                    let end;
                    try { end = await settle(done); } catch { return { error: 'completion predicate never fired' }; }
                    if (i >= warmup) measured.push(end - start);
                    reset();
                    try { await settle(resetDone); } catch { return { error: 'reset predicate never fired' }; }
                }
                return { measured };
            }, { src: spec, warmup: WARMUP, samples: SAMPLES });

            if (durations.error) {
                results.push({ id: interaction.id, verdict: 'blocked', reason: durations.error });
                console.error(`${interaction.id}: BLOCKED — ${durations.error}`);
                roundP95s.length = 0;
                break;
            }
            roundSamples = durations.measured;
            roundP95s.push(percentile(durations.measured, 95));
        }

        if (roundP95s.length === ROUNDS) {
            const p95 = median(roundP95s);
            results.push({
                id: interaction.id,
                verdict: p95 < threshold ? 'pass' : 'fail',
                p50: Number(percentile(roundSamples, 50).toFixed(2)),
                p95: Number(p95.toFixed(2)),
                max: Number(Math.max(...roundSamples).toFixed(2)),
                sampleCount: roundSamples.length,
                rounds: roundP95s.map((value) => Number(value.toFixed(2))),
            });
            console.log(`${interaction.id}: p95 ${p95.toFixed(2)}ms (${p95 < threshold ? 'pass' : 'fail'})`);
        }
    }
} finally {
    fixtureServer?.close();
    await browser.close();
}

const allPass = results.length > 0 && results.every((entry) => entry.verdict === 'pass');
const payload = {
    capturedAt: new Date().toISOString(),
    surface: surfaceName,
    url,
    protocol: { warmup: WARMUP, samples: SAMPLES, rounds: ROUNDS, statistic: 'median of per-round p95', thresholdMs: threshold },
    verdict: allPass ? 'pass' : 'fail',
    results,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`E4 ${payload.verdict} -> ${outPath}`);
process.exit(allPass ? 0 : 1);
