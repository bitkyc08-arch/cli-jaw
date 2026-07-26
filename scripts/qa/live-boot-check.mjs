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

/**
 * Every descendant of a pid, with enough identity to prove ownership later.
 *
 * A pid alone is not ownership. Between recording it and sending a signal the
 * process can exit and the number be reused, and then teardown kills a
 * stranger. Each entry carries the start time and the command, so the killer
 * can re-check that the pid is still the same process before signalling.
 */
function descendants(pid) {
    try {
        const out = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8' });
        const children = new Map();
        const meta = new Map();
        for (const line of out.trim().split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
            if (!m) continue;
            const [, p, pp, started, command] = m;
            const pidNum = Number(p);
            if (!children.has(Number(pp))) children.set(Number(pp), []);
            children.get(Number(pp)).push(pidNum);
            meta.set(pidNum, { pid: pidNum, started, command });
        }
        const found = [];
        const walk = (p) => {
            for (const c of children.get(p) ?? []) {
                if (meta.has(c)) found.push(meta.get(c));
                walk(c);
            }
        };
        walk(pid);
        return found;
    } catch { return []; }
}

/**
 * Is this pid still the very process we recorded?
 *
 * An entry without a recorded start time and command cannot answer that, and
 * must never be treated as ours — `''.includes('')` is true, which is how the
 * root pid slipped past this check entirely and could have had TERM sent to
 * whatever inherited its number.
 */
function stillOurs(entry) {
    if (!entry?.started?.trim() || !entry?.command?.trim()) return false;
    // Exact equality on the FULL start time and the FULL command. A substring
    // match on the first 40 characters plus a second-resolution timestamp can
    // be satisfied by a recycled pid that happens to run a similar command in
    // the same second — which for a tree of identical Electron helpers is not
    // far-fetched.
    const now = identify(entry.pid);
    if (!now) return false;
    return now.started === entry.started && now.command === entry.command;
}

/** Read one process's identity, so the root can be pinned like any child. */
function identify(pid) {
    try {
        const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
        const m = out.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
        return m ? { pid, started: m[1], command: m[2] } : null;
    } catch { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every live process in our group, whatever its parent has become. */
function groupMembers(pgid) {
    try {
        const out = execFileSync('/bin/ps', ['-eo', 'pid=,pgid=,lstart=,command='], { encoding: 'utf8' });
        const found = [];
        for (const line of out.trim().split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
            if (!m) continue;
            if (Number(m[2]) !== pgid) continue;
            found.push({ pid: Number(m[1]), started: m[3], command: m[4] });
        }
        return found;
    } catch { return []; }
}

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

// A private debugging port so the renderer can be asked what it loaded. It has
// to differ from any developer session (agbrowse uses 9222).
const debugPort = 9333 + Math.floor(Math.random() * 400);
const userData = await mkdtemp(join(tmpdir(), 'cli-jaw-boot-'));
let child = null;
let rootIdentity = null;
let owned = new Set();
let ownedEntries = [];
// Everything we have ever seen in our own tree, keyed by pid. A child that is
// reparented to PID 1 after the root exits vanishes from a descendants() walk,
// so a scan-based "zero left" proof would pass while it is still running. The
// registry remembers it, identity and all.
const registry = new Map();
const remember = (entries) => { for (const e of entries) if (e?.started) registry.set(e.pid, e); };

try {
    // Its own process group. Without one, a helper spawned after the last scan
    // and immediately reparented to PID 1 leaves the tree we can walk, so a
    // "zero survivors" claim based on descendants could not actually see it.
    // The group id is an OS-level fact about who started what, and it does not
    // move when a parent dies.
    child = spawn(binary, [`--remote-debugging-port=${debugPort}`], {
        env: { ...process.env, JAW_ELECTRON_USER_DATA: userData },
        stdio: 'ignore',
        detached: true,   // setsid: the child becomes its own group leader
    });
    child.unref();
    report.launchedPid = child.pid;
    report.debugPort = debugPort;
    // Pin the root the same way as every child. Without this it had no identity
    // to re-verify against and was signalled unconditionally.
    rootIdentity = identify(child.pid);
    if (!rootIdentity) {
        // Without an identity for the root we cannot prove ownership of
        // anything, and teardown would be guessing. Kill it through the handle
        // we still hold — that needs no identity — and stop. Carrying on would
        // leave an unowned Electron tree behind that the leftover check cannot
        // even see, because the root never entered the registry.
        record('root-process-identified', false, { pid: child.pid });
        // Kill the GROUP: by the time identification failed, children may
        // already exist that the handle does not own.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no group */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 1500));
        await rm(userData, { recursive: true, force: true }).catch(() => {});
        console.error('[boot] could not identify the launched process; killed it via the child handle');
        process.exit(1);
    } else {
        registry.set(rootIdentity.pid, rootIdentity);
        record('root-process-identified', true, { pid: child.pid, command: rootIdentity.command.slice(0, 60) });
    }
    console.error(`[boot] launched pid ${child.pid} with userData ${userData}, debug port ${debugPort}`);

    // Wait for a manager that belongs to us.
    const deadline = Date.now() + timeoutMs;
    let manager = null;
    while (Date.now() < deadline && !manager) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!alive(child.pid)) break;
        ownedEntries = descendants(child.pid);
        remember(ownedEntries);
        owned = new Set([child.pid, ...ownedEntries.map((e) => e.pid)]);
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

        // Did the RENDERER reach that origin?
        //
        // Fetching the URL ourselves only proves the manager serves HTML. It
        // says nothing about whether the isolated Electron window loaded it —
        // a window showing a blank error page would pass. So ask the renderer:
        // the isolated instance is launched with its own remote-debugging port,
        // and we read the page URL and mounted root out of it.
        try {
            const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`,
                { signal: AbortSignal.timeout(5000) });
            const targets = await targetsRes.json();
            const dash = targets.find((t) => typeof t.url === 'string' && t.url.includes('/dashboard2'));
            record('renderer-loaded-the-dashboard', Boolean(dash),
                { url: dash?.url ?? null, title: dash?.title ?? null,
                  targets: targets.length, debugPort,
                  note: 'read from the isolated window, not from an HTTP fetch' });

            // And it must be OUR manager's origin, not some other one.
            if (dash) {
                record('renderer-origin-matches-our-manager',
                    dash.url.includes(`:${manager.port}/`),
                    { rendererUrl: dash.url, managerPort: manager.port });
            }
        } catch (error) {
            record('renderer-loaded-the-dashboard', false,
                { error: String(error.message).slice(0, 90), debugPort });
        }
    }
} finally {
    // Only what we started, and re-verified immediately before each signal.
    //
    // A pid list captured minutes ago is not proof of ownership: the process can
    // exit and the number be reused, and then the second pass kills a stranger.
    // Re-scan for late children too, since Electron may respawn a manager after
    // the snapshot was taken.
    // Everything still alive that we know is ours: the registry (which survives
    // reparenting) plus a fresh walk to catch anything spawned since.
    const scan = () => {
        if (!child) return [];
        // Three sources, because each misses something the others catch: the
        // process group (survives reparenting), a descendants walk (catches
        // anything that left the group), and the registry (remembers what we
        // have already seen).
        remember(groupMembers(child.pid));
        remember(descendants(child.pid));
        if (rootIdentity) registry.set(rootIdentity.pid, rootIdentity);
        return [...registry.values()].filter((e) => alive(e.pid) && stillOurs(e));
    };
    const signalled = [];
    for (const entry of scan().reverse()) {
        if (!stillOurs(entry)) continue;   // pid reused, or no identity: not ours
        try { process.kill(entry.pid, 'SIGTERM'); signalled.push(entry.pid); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 2500));
    for (const entry of scan()) {
        if (!alive(entry.pid) || !stillOurs(entry)) continue;
        try { process.kill(entry.pid, 'SIGKILL'); signalled.push(entry.pid); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Prove the teardown rather than assuming it: nothing we owned is left, and
    // our manager's port is free again.
    // Check the registry, not the tree: a reparented survivor is no longer a
    // descendant of anything we launched.
    // Survivors from both angles: anything we recorded that is still ours, and
    // anything still sitting in our process group that we never even saw.
    remember(groupMembers(child?.pid ?? -1));
    const leftovers = [...registry.values()].filter((e) => alive(e.pid) && stillOurs(e));
    const strayGroup = child ? groupMembers(child.pid).filter((e) => !registry.has(e.pid)) : [];
    for (const stray of strayGroup) {
        try { process.kill(stray.pid, 'SIGKILL'); signalled.push(stray.pid); } catch { /* gone */ }
    }
    let portFreed = true;
    if (report.checks['manager-came-up']?.port) {
        try {
            await fetch(`http://127.0.0.1:${report.checks['manager-came-up'].port}/api/dashboard/health`,
                { signal: AbortSignal.timeout(1500) });
            portFreed = false;
        } catch { portFreed = true; }
    }
    report.teardown = { signalled: [...new Set(signalled)], leftovers: leftovers.map((e) => e.pid),
                        strayGroupMembers: strayGroup.map((e) => e.pid), portFreed };
    if (leftovers.length || !portFreed) {
        failures.push('teardown-left-processes');
        console.error(`FAIL teardown-left-processes  ${JSON.stringify(report.teardown)}`);
    }
    await rm(userData, { recursive: true, force: true }).catch(() => {});
    console.error(`[boot] signalled ${new Set(signalled).size} owned process(es), `
        + `${leftovers.length} left, port freed: ${portFreed}`);
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
