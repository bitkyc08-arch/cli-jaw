#!/usr/bin/env node
// wplive — does the installed app actually boot?
//
// This is deliberately NOT verify-sidecar-deps.mjs. That one proves the
// dependency closure resolves, which is a precondition and not a boot. The
// user's report was a window with a crashed sidecar behind it, and no amount
// of dependency checking would have shown that.
//
// Two things make this honest:
//
// Isolation. The app takes a single-instance lock keyed on userData, so simply
// re-running the binary while a copy is open just focuses the existing window
// and spawns no sidecar at all — the check would pass without booting
// anything. A temporary JAW_ELECTRON_USER_DATA moves the lock aside; that
// override exists for exactly this.
//
// Ownership. We only ever tear down the process tree we started. A developer's
// running app and its manager are left alone, always, including on failure.
//
// What is NOT checked: sidecar stderr. It is piped into Electron's own ring
// buffer and never reaches an outside process, so "stderr is clean" is not
// observable from here. A sidecar that dies shows up instead as a manager PID
// that changes generation or a health endpoint that stops answering.
//
// Usage: node scripts/qa/live-boot-check.mjs [--app /Applications/cli-jaw.app]
//                                            [--timeout 60000] [--out path]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const appPath = flag('app', '/Applications/cli-jaw.app');
const timeoutMs = Number(flag('timeout', '60000'));
const outPath = flag('out');

const binary = join(appPath, 'Contents', 'MacOS', 'cli-jaw');
if (!existsSync(binary)) {
    console.error(`[boot] no executable at ${binary}`);
    process.exit(2);
}

const report = { when: new Date().toISOString(), app: appPath, checks: {} };
const failures = [];
const record = (name, ok, detail) => {
    report.checks[name] = { ok, ...detail };
    if (!ok) failures.push(name);
    console.error(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`);
};

/** Every descendant of a pid, so teardown never reaches beyond what we started. */
function descendants(pid) {
    try {
        const out = execFileSync('/bin/ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
        const children = new Map();
        for (const line of out.trim().split('\n')) {
            const [p, pp] = line.trim().split(/\s+/).map(Number);
            if (!children.has(pp)) children.set(pp, []);
            children.get(pp).push(p);
        }
        const found = [];
        const walk = (p) => { for (const c of children.get(p) ?? []) { found.push(c); walk(c); } };
        walk(pid);
        return found;
    } catch { return []; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Which port did our own instance settle on? It picks a free one from 24577. */
async function findOurManager(ownedPids) {
    for (let port = 24577; port <= 24590; port += 1) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/health`,
                { signal: AbortSignal.timeout(1500) });
            if (!res.ok) continue;
            const health = await res.json();
            // Only ours. Another developer's manager on this range is not our
            // boot and must not be measured — or torn down.
            if (ownedPids.has(health.pid)) return { port, health };
        } catch { /* not up yet */ }
    }
    return null;
}

const userData = await mkdtemp(join(tmpdir(), 'cli-jaw-boot-'));
let child = null;
let owned = new Set();

try {
    child = spawn(binary, [], {
        env: { ...process.env, JAW_ELECTRON_USER_DATA: userData },
        stdio: 'ignore',
        detached: false,
    });
    report.launchedPid = child.pid;
    console.error(`[boot] launched pid ${child.pid} with userData ${userData}`);

    // Wait for a manager that belongs to us.
    const deadline = Date.now() + timeoutMs;
    let manager = null;
    while (Date.now() < deadline && !manager) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!alive(child.pid)) break;
        owned = new Set([child.pid, ...descendants(child.pid)]);
        manager = await findOurManager(owned);
    }

    record('electron-process-alive', alive(child.pid), { pid: child.pid });
    record('manager-came-up', Boolean(manager),
        manager ? { pid: manager.health.pid, port: manager.port } : { searched: '24577-24590', timeoutMs });

    if (manager) {
        // A sidecar that crashes and gets respawned shows up here as a changing
        // pid. Watch it settle rather than sampling once.
        const generations = new Set([manager.health.pid]);
        let answeredEvery = true;
        for (let i = 0; i < 6; i += 1) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
                const res = await fetch(`http://127.0.0.1:${manager.port}/api/dashboard/health`,
                    { signal: AbortSignal.timeout(2000) });
                if (!res.ok) { answeredEvery = false; continue; }
                generations.add((await res.json()).pid);
            } catch { answeredEvery = false; }
        }
        record('manager-pid-stable', generations.size === 1,
            { generations: [...generations], note: 'more than one means a restart loop' });
        record('health-answers-continuously', answeredEvery, { samples: 6 });

        // And the renderer really reached that origin.
        try {
            const res = await fetch(`http://127.0.0.1:${manager.port}/dashboard2/`,
                { signal: AbortSignal.timeout(4000) });
            const html = await res.text();
            record('renderer-origin-serves-dashboard', res.ok && html.includes('dashboard2-root'),
                { status: res.status, port: manager.port });
        } catch (error) {
            record('renderer-origin-serves-dashboard', false, { error: String(error.message).slice(0, 80) });
        }
    }
} finally {
    // Only what we started, and only ever by pid we recorded.
    const toKill = [...new Set([...(child ? [child.pid] : []), ...(child ? descendants(child.pid) : [])])];
    for (const pid of toKill.reverse()) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 2500));
    for (const pid of toKill) {
        if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    report.tornDown = toKill;
    await rm(userData, { recursive: true, force: true }).catch(() => {});
    console.error(`[boot] tore down ${toKill.length} owned process(es) and ${userData}`);
}

report.failures = failures;
if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`[boot] wrote ${outPath}`);
}

if (failures.length) {
    console.error(`\nFAIL: the app did not boot cleanly (${failures.join(', ')})`);
    process.exit(1);
}
console.error(`\nOK: ${Object.keys(report.checks).length} boot checks passed`);
