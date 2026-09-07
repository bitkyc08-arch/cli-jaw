// Burst measurement for browser and CLI rate-limit isolation.
// Three sequential phases so before/after runs are deterministic:
//   0. fetch + validate the Bearer token BEFORE any load (429-impossible here)
//   1. "sacrificial" lane: 350 unheadered (browser-class) GETs, concurrency 20
//      — exceeds the browser poll budget (300/min) to force the 429 branch
//   2. "protected" lane: Bearer (cli-class) chat-sessions/switch/goal traffic
//      — must see zero 429s after hardening; deterministically 429s before it
//      (the old single 120/min bucket is already exhausted by phase 1).
// Usage: node scripts/burst-scenario.mjs --port <P> --switch-seq <N> [--sacrificial-count 350]

const args = process.argv.slice(2);
function argOf(name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
}
const PORT = Number(argOf('--port'));
const SWITCH_SEQ = argOf('--switch-seq', '');
const SACRIFICIAL = Number(argOf('--sacrificial-count', '350'));
if (!PORT) { console.error('usage: burst-scenario.mjs --port <P> --switch-seq <N>'); process.exit(1); }
const BASE = `http://127.0.0.1:${PORT}`;

// Phase 0 — token first: after phase 1 exhausts the shared bucket, a
// pre-hardening server would 429 the token endpoint itself.
const tokenRes = await fetch(`${BASE}/api/auth/token`);
const token = tokenRes.ok ? (await tokenRes.json()).token || '' : '';
if (!token) { console.error('token fetch failed — aborting'); process.exit(1); }
const AUTH = { Authorization: `Bearer ${token}` };

async function fire(url, init = {}) {
    try {
        const res = await fetch(url, init);
        return { status: res.status, retryAfter: res.headers.get('retry-after') };
    } catch {
        return { status: 0, retryAfter: null };
    }
}

// Phase 1 — sacrificial burst, bounded concurrency 20, single-window guard.
const phase1Start = Date.now();
const sacrificial = { total: 0, s429: 0, retryAfterSeen: false };
let inFlight = [];
for (let i = 0; i < SACRIFICIAL; i++) {
    inFlight.push(fire(`${BASE}/api/messages/count`).then(r => {
        sacrificial.total++;
        if (r.status === 429) {
            sacrificial.s429++;
            if (r.retryAfter) sacrificial.retryAfterSeen = true;
        }
    }));
    if (inFlight.length >= 20) { await Promise.all(inFlight); inFlight = []; }
}
await Promise.all(inFlight);
const phase1ElapsedMs = Date.now() - phase1Start;
if (phase1ElapsedMs > 45_000) {
    console.error(`phase 1 took ${phase1ElapsedMs}ms — crossed the window boundary, scenario invalid`);
    process.exit(1);
}

// Phase 2 — protected lane (cli class via Bearer).
const protectedLane = { total: 0, s429: 0 };
function track(promise) {
    return promise.then(r => { protectedLane.total++; if (r.status === 429) protectedLane.s429++; });
}
const protectedCalls = [];
for (let i = 0; i < 20; i++) protectedCalls.push(track(fire(`${BASE}/api/chat-sessions`, { headers: AUTH })));
for (let i = 0; i < 5; i++) {
    protectedCalls.push(track(fire(`${BASE}/api/chat-sessions/${SWITCH_SEQ}/switch`, { method: 'POST', headers: AUTH })));
}
for (let i = 0; i < 10; i++) protectedCalls.push(track(fire(`${BASE}/api/goal`, { headers: AUTH })));
await Promise.all(protectedCalls);

console.log(JSON.stringify({ tokenOk: true, phase1ElapsedMs, sacrificial, protected: protectedLane }, null, 2));
