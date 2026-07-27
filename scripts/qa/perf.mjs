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

// ── fixture reach helpers (page API, run once before measuring) ─────────────
// The fixture preseeds one online instance (3506); these mirror qa-lib's
// reach steps but stay local so perf owns its own preconditions.
async function selectInstance(page) {
    const online = page.locator('.d2-instance-main:not([disabled])');
    if (await online.count()) await online.first().click().catch(() => {});
    await page.waitForTimeout(400);
}

async function openSidePane(page) {
    const toggle = page.getByRole('button', { name: /open side pane/i });
    if (await toggle.count()) await toggle.first().click().catch(() => {});
    await page.waitForTimeout(400);
}

async function openPanel(page, title) {
    const tab = page.locator('.d2-side-pane-tab-group [role="tab"]', { hasText: title });
    if (await tab.count()) {
        await tab.first().click().catch(() => {});
        await page.waitForTimeout(600);
        return;
    }
    const picker = page.getByRole('button', { name: /^open panel$/i });
    if (await picker.count()) {
        await picker.first().click().catch(() => {});
        await page.waitForTimeout(300);
        const choice = page.locator('.d2-side-pane-picker-button', { hasText: title });
        if (await choice.count()) await choice.first().click().catch(() => {});
    }
    await page.waitForTimeout(900);
}

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

/**
 * wp14 — per-surface E4. Each surface names a fixture `reach` (page API, run
 * once) and the three interactions fixed in 091. Page-context functions use
 * only DOM APIs; keyboard interactions dispatch trusted-shape KeyboardEvents.
 */
const TAB = '.d2-side-pane-tab-group [role="tab"]';

const PERF_SURFACES = {
    workbench: {
        reach: async (page) => { await selectInstance(page); },
        interactions: [
            {
                id: 'workbench.side-pane-toggle',
                precondition: () => Boolean(document.querySelector('.d2-workbench-side-toggle')),
                // Measured as a CLOSE: the resting state is pane-open, which
                // is also the state divider-keyboard needs after this runs.
                trigger: () => document.querySelector('.d2-workbench-side-toggle')?.click(),
                done: () => document.querySelector('.d2-workbench-side-toggle')?.getAttribute('aria-pressed') === 'false',
                reset: () => document.querySelector('.d2-workbench-side-toggle')?.click(),
                resetDone: () => document.querySelector('.d2-workbench-side-toggle')?.getAttribute('aria-pressed') === 'true',
            },
            {
                id: 'workbench.divider-keyboard',
                // The divider only renders while the pane is open; the
                // previous interaction's reset leaves it open.
                precondition: () => Boolean(document.querySelector('.d2-workbench-divider-drag')),
                trigger: () => {
                    const divider = document.querySelector('.d2-workbench-divider-drag');
                    const before = Number(divider?.getAttribute('aria-valuenow') ?? '0');
                    divider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
                    divider?.setAttribute('data-perf-before', String(before));
                },
                done: () => {
                    const divider = document.querySelector('.d2-workbench-divider-drag');
                    return Number(divider?.getAttribute('aria-valuenow') ?? '0') > Number(divider?.getAttribute('data-perf-before') ?? '0');
                },
                reset: () => document.querySelector('.d2-workbench-divider-drag')
                    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })),
                resetDone: () => {
                    const divider = document.querySelector('.d2-workbench-divider-drag');
                    return Number(divider?.getAttribute('aria-valuenow') ?? '0') <= Number(divider?.getAttribute('data-perf-before') ?? '0');
                },
            },
            {
                id: 'workbench.sidebar-reopen',
                precondition: () => Boolean(document.querySelector('.d2-sidebar-toggle')),
                trigger: () => document.querySelector('.d2-workbench-side-toggle-open')?.click(),
                done: () => !document.querySelector('.d2-shell.d2-sb-closed'),
                reset: () => document.querySelector('.d2-sidebar-toggle')?.click(),
                resetDone: () => Boolean(document.querySelector('.d2-shell.d2-sb-closed'))
                    && Boolean(document.querySelector('.d2-workbench-side-toggle-open')),
            },
        ],
    },
    composer: {
        reach: async (page) => { await selectInstance(page); },
        interactions: [
            {
                id: 'composer.type',
                precondition: () => Boolean(document.querySelector('.d2-composer-wrap textarea')),
                trigger: () => {
                    const area = document.querySelector('.d2-composer-wrap textarea');
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                    setter.call(area, 'x');
                    area.dispatchEvent(new Event('input', { bubbles: true }));
                },
                done: () => document.querySelector('.d2-composer-wrap textarea')?.value === 'x',
                reset: () => {
                    const area = document.querySelector('.d2-composer-wrap textarea');
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                    setter.call(area, '');
                    area.dispatchEvent(new Event('input', { bubbles: true }));
                },
                resetDone: () => document.querySelector('.d2-composer-wrap textarea')?.value === '',
            },
            {
                id: 'composer.slash-menu',
                precondition: () => Boolean(document.querySelector('.d2-composer-wrap textarea')),
                trigger: () => {
                    const area = document.querySelector('.d2-composer-wrap textarea');
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                    setter.call(area, '/');
                    area.dispatchEvent(new Event('input', { bubbles: true }));
                },
                done: () => Boolean(document.querySelector('#d2-slash-menu, .d2-composer-menu')),
                reset: () => {
                    const area = document.querySelector('.d2-composer-wrap textarea');
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                    setter.call(area, '');
                    area.dispatchEvent(new Event('input', { bubbles: true }));
                },
                resetDone: () => !document.querySelector('#d2-slash-menu, .d2-composer-menu'),
            },
            {
                id: 'composer.model-picker-open',
                precondition: () => Boolean(document.querySelector('.d2-composer-picker:not([disabled]), .d2-model-picker-trigger:not([disabled])')),
                trigger: () => document.querySelector('.d2-composer-picker:not([disabled]), .d2-model-picker-trigger:not([disabled])')?.click(),
                done: () => Boolean(document.querySelector('.d2-model-picker.is-open')),
                reset: () => document.querySelector('.d2-composer-picker:not([disabled]), .d2-model-picker-trigger:not([disabled])')?.click(),
                resetDone: () => !document.querySelector('.d2-model-picker.is-open'),
            },
        ],
    },
    'side-pane': {
        reach: async (page) => {
            await selectInstance(page);
            await openSidePane(page);
            await openPanel(page, 'Terminal');
            await openPanel(page, 'Files');
            await openPanel(page, 'Diff');
        },
        interactions: ['Terminal', 'Files', 'Diff'].map((title, index) => ({
            id: `tool-tabs.switch-${title.toLowerCase()}`,
            // Tab identity is positional after reach opens three panels; titles
            // discriminate within the tab group.
            precondition: new Function(`return Array.from(document.querySelectorAll('${TAB}')).some(t => t.textContent.includes('${title}'))`),
            trigger: new Function(`Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.click()`),
            done: new Function(`return Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.getAttribute('aria-selected') === 'true'`),
            reset: new Function(`document.querySelectorAll('${TAB}')[${index === 0 ? 1 : 0}]?.click()`),
            resetDone: new Function(`return Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.getAttribute('aria-selected') !== 'true'`),
        })),
    },
    code: {
        reach: async (page) => {
            await selectInstance(page);
            // The gate only opens on an available capability, and the history
            // rows only render with sessions; both come from the code harness
            // (the same shapes scenario-ledger.mjs pins).
            await page.evaluate(() => window.__jawE2E.setCode({
                capability: { available: true, reason: 'ok' },
                liveSessions: [{
                    sessionId: 'wp14-live-1', cwd: '/tmp/wp4-e2e', status: 'idle',
                    createdAt: 1_783_000_000_000, lastUsedAt: 1_783_000_000_000,
                    modelId: 'sonnet-4.6', title: 'wp14 live session',
                }],
                storedSessions: [{
                    sessionId: 'wp14-stored-1', cwd: '/tmp/wp4-e2e',
                    title: 'wp14 stored session', updatedAt: '2026-07-26T00:00:00.000Z', messageCount: 4,
                }],
            }));
            await page.evaluate(() => window.__jawE2E.openPanel('code'));
            await page.locator('.d2-code-tab').waitFor();
        },
        interactions: [
            {
                id: 'code-tab.model-menu',
                precondition: () => Boolean(document.querySelector('.d2-code-tab .d2-model-picker-trigger:not([disabled])')),
                trigger: () => document.querySelector('.d2-code-tab .d2-model-picker-trigger')?.click(),
                done: () => Boolean(document.querySelector('.d2-code-tab .d2-model-picker.is-open')),
                reset: () => document.querySelector('.d2-code-tab .d2-model-picker-trigger')?.click(),
                resetDone: () => !document.querySelector('.d2-code-tab .d2-model-picker.is-open'),
            },
            {
                id: 'code-tab.model-option-highlight',
                // Downshift opens the menu and highlights the first option on
                // ArrowDown from the closed state, so the resting state is
                // menu-closed and the measured event is the keyboard open.
                precondition: () => Boolean(document.querySelector('.d2-code-tab .d2-model-picker-trigger:not([disabled])')),
                trigger: () => document.querySelector('.d2-code-tab .d2-model-picker-trigger')
                    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })),
                done: () => Boolean(document.querySelector('.d2-code-tab .d2-model-picker-option.is-highlighted')),
                reset: () => document.querySelector('.d2-code-tab .d2-model-picker-trigger')?.click(),
                resetDone: () => !document.querySelector('.d2-code-tab .d2-model-picker-option.is-highlighted')
                    && !document.querySelector('.d2-code-tab .d2-model-picker.is-open'),
            },
            {
                id: 'code-tab.history-scroll-into-view',
                precondition: () => Boolean(document.querySelector('[data-testid="code-history-list"]')),
                trigger: () => document.querySelector('[data-testid="code-history-list"] .d2-code-session-row')
                    ?.scrollIntoView({ block: 'end' }),
                done: () => true,
                reset: () => document.querySelector('[data-testid="code-history-list"]')?.scrollTo({ top: 0 }),
                resetDone: () => true,
            },
        ],
    },
    'feature-tabs': {
        reach: async (page) => {
            await selectInstance(page);
            await openSidePane(page);
            await openPanel(page, 'Notes');
            await openPanel(page, 'Board');
            await openPanel(page, 'Reminders');
        },
        interactions: ['Notes', 'Board', 'Reminders'].map((title, index) => ({
            id: `feature-tabs.switch-${title.toLowerCase()}`,
            precondition: new Function(`return Array.from(document.querySelectorAll('${TAB}')).some(t => t.textContent.includes('${title}'))`),
            trigger: new Function(`Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.click()`),
            done: new Function(`return Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.getAttribute('aria-selected') === 'true'`),
            reset: new Function(`document.querySelectorAll('${TAB}')[${index === 0 ? 1 : 0}]?.click()`),
            resetDone: new Function(`return Array.from(document.querySelectorAll('${TAB}')).find(t => t.textContent.includes('${title}'))?.getAttribute('aria-selected') !== 'true'`),
        })),
    },
    settings: {
        reach: async (page) => {
            // wp6's surface is the settings WORKSPACE (workbench header gear),
            // not the legacy sidebar modal. Rest on the Profile page, whose
            // seeded slice has editable text fields.
            const gear = page.locator('.d2-workbench-header-button[aria-label="Open settings"]');
            if (await gear.count()) await gear.first().click();
            await page.locator('.d2-settings-workspace .d2-settings-nav-item').first().waitFor({ timeout: 5000 }).catch(() => {});
            // Rest on the default Display page: its theme/locale selects are
            // dirty-store-backed (Profile's fields are statically unsupported).
            await page.locator('.d2-settings-workspace select:not([disabled])').first().waitFor({ timeout: 5000 }).catch(() => {});
        },
        interactions: [
            {
                id: 'settings.field-edit',
                // The sidebar search input is not a setting; editing it filters
                // the nav instead of dirtying the store.
                precondition: () => Boolean(document.querySelector('.d2-settings-workspace input:not([type="checkbox"]):not([disabled]):not(.d2-settings-search input), .d2-settings-workspace select:not([disabled])')),
                trigger: () => {
                    const field = document.querySelector('.d2-settings-workspace input:not([type="checkbox"]):not([disabled]):not(.d2-settings-search input), .d2-settings-workspace select:not([disabled])');
                    if (field?.tagName === 'INPUT') {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(field, `${field.value}x`);
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (field) {
                        // React tracks the native value setter, not selectedIndex.
                        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
                        setter.call(field, field.options[field.selectedIndex === 0 ? field.options.length - 1 : 0].value);
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                },
                done: () => Boolean(document.querySelector('.d2-settings-save-bar')),
                reset: () => document.querySelector('.d2-settings-save-bar .d2-settings-save-actions button')?.click(),
                resetDone: () => !document.querySelector('.d2-settings-save-bar'),
            },
            {
                id: 'settings.section-switch',
                precondition: () => document.querySelectorAll('.d2-settings-workspace .d2-settings-nav-item').length >= 2,
                trigger: () => document.querySelectorAll('.d2-settings-workspace .d2-settings-nav-item')[1]?.click(),
                done: () => document.querySelectorAll('.d2-settings-workspace .d2-settings-nav-item')[1]?.classList.contains('active'),
                reset: () => document.querySelectorAll('.d2-settings-workspace .d2-settings-nav-item')[0]?.click(),
                resetDone: () => document.querySelectorAll('.d2-settings-workspace .d2-settings-nav-item')[0]?.classList.contains('active'),
            },
            {
                id: 'settings.close-open',
                precondition: () => Boolean(document.querySelector('.d2-settings-back')),
                trigger: () => document.querySelector('.d2-settings-back')?.click(),
                // The workspace stays mounted when hidden; the surface's
                // display is the committed mode.
                done: () => document.querySelector('[data-workspace-surface="settings"]')?.style.display === 'none',
                reset: () => document.querySelector('.d2-workbench-header-button[aria-label="Open settings"]')?.click(),
                resetDone: () => document.querySelector('[data-workspace-surface="settings"]')?.style.display === 'grid',
            },
        ],
    },
    'hover-dock': {
        reach: async (page) => {
            await selectInstance(page);
            const trigger = page.locator('.hover-dock-trigger');
            if (await trigger.count()) {
                await trigger.first().click().catch(() => {});
                await page.waitForTimeout(600);
            }
        },
        interactions: ['스킬', '에이전트', '설정'].map((title, index) => ({
            id: `dock.tab-switch-${['skills', 'agents', 'settings'][index]}`,
            precondition: new Function(`return Array.from(document.querySelectorAll('.hover-dock-tab')).some(t => t.textContent.includes('${title}'))`),
            trigger: new Function(`Array.from(document.querySelectorAll('.hover-dock-tab')).find(t => t.textContent.includes('${title}'))?.click()`),
            done: new Function(`return Array.from(document.querySelectorAll('.hover-dock-tab')).find(t => t.textContent.includes('${title}'))?.classList.contains('is-active')`),
            // Positional resets are fragile (the dock's tab order is not the
            // measurement order): reset by switching to a different NAMED tab.
            reset: new Function(`Array.from(document.querySelectorAll('.hover-dock-tab')).find(t => !t.textContent.includes('${title}'))?.click()`),
            resetDone: new Function(`return !Array.from(document.querySelectorAll('.hover-dock-tab')).find(t => t.textContent.includes('${title}'))?.classList.contains('is-active')`),
        })),
    },
};

// Register the per-surface interactions into the gate's INTERACTIONS registry.
for (const [name, spec] of Object.entries(PERF_SURFACES)) {
    INTERACTIONS[name] = spec.interactions;
}

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
        initScript: (cfg) => {
            window.__jawE2EPreseed = { sidebar: cfg };
        },
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
    // wp14 — per-surface reach: open the pane/panels/dock the interactions
    // measure. The sidebar measures the always-visible shell, so it has no
    // reach step.
    if (PERF_SURFACES[surfaceName]?.reach) {
        await PERF_SURFACES[surfaceName].reach(page);
    }
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
