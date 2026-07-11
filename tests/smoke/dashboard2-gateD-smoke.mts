// 048 Gate D2/D3 — SSE reconnect lastEventId replay + preferences registry
// PATCH round-trip, against a real jaw instance + dashboard manager.
// Usage: npx tsx tests/smoke/dashboard2-gateD-smoke.mts [--port 3979]
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 3981;
const BASE = `http://127.0.0.1:${PORT}`;

async function readSse(url: string, ms: number): Promise<{ ids: string[]; events: string[] }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ms);
    const ids: string[] = [];
    const events: string[] = [];
    try {
        const response = await fetch(url, { signal: abort.signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line.startsWith('id:')) ids.push(line.slice(3).trim());
                if (line.startsWith('data:')) {
                    try { events.push(JSON.parse(line.slice(5)).event ?? '?'); } catch { /* skip */ }
                }
            }
        }
    } catch { /* aborted = expected */ }
    clearTimeout(timer);
    return { ids, events };
}

async function main(): Promise<void> {
    const server = spawn('node', [join(ROOT, 'dist/bin/cli-jaw.js'), 'serve', `--${PORT}`], { stdio: 'ignore' });
    const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
    process.on('exit', cleanup);
    for (let i = 0; i < 60; i++) {
        try { await fetch(`${BASE}/api/settings`); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
    }

    // ── D2: lastEventId replay ─────────────────────────────────────
    // real events need a real (tiny) turn: one tool call via claude
    await fetch(`${BASE}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: 'claude' }),
    });
    const runTiny = () => fetch(`${BASE}/api/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Run `date` with one tool call, reply one word.' }),
    });
    const firstPromise = readSse(`${BASE}/api/events`, 25_000);
    await runTiny();
    const first = await firstPromise;
    const lastId = first.ids[first.ids.length - 1];
    // produce MORE events while disconnected
    await runTiny();
    await new Promise(r => setTimeout(r, 20_000));
    const replay = await readSse(`${BASE}/api/events?lastEventId=${encodeURIComponent(lastId ?? '')}`, 5000);
    const d2 = {
        firstIds: first.ids.length,
        lastId,
        replayedIds: replay.ids.length,
        replayStrictlyAfter: replay.ids.every(id => Number(id) > Number(lastId)),
        replayedNonEmpty: replay.ids.length > 0,
    };
    console.log('[gateD2]', JSON.stringify(d2));

    // ── D3: preferences registry PATCH round-trip (manager dashboard on 24576) ──
    // mutate-then-restore against the live manager registry
    let d3: Record<string, unknown> = { skipped: true };
    try {
        const MANAGER = 'http://127.0.0.1:24576';
        const readTheme = async () => (await (await fetch(`${MANAGER}/api/dashboard/registry`)).json())
            ?.registry?.ui?.uiTheme as string | undefined;
        const patchTheme = (uiTheme: string) => fetch(`${MANAGER}/api/dashboard/registry`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui: { uiTheme } }),
        });
        const originalTheme = (await readTheme()) ?? 'auto';
        const flipped = originalTheme === 'dark' ? 'light' : 'dark';
        await patchTheme(flipped);
        const flippedPersisted = (await readTheme()) === flipped;
        await patchTheme(originalTheme);
        const restored = (await readTheme()) === originalTheme;
        d3 = { skipped: false, originalTheme, flippedPersisted, restored };
    } catch (error) {
        d3 = { skipped: true, reason: String(error) };
    }
    console.log('[gateD3]', JSON.stringify(d3));

    writeFileSync(join(ROOT, 'devlog/_plan/260711_manager_redesign_feature_migration/refs/048-gateD-evidence.json'),
        JSON.stringify({ d2, d3, at: new Date().toISOString() }, null, 2));
    cleanup();
    process.exit(d2.replayedNonEmpty && d2.replayStrictlyAfter ? 0 : 1);
}

main().catch(error => { console.error('[gateD] fatal', error); process.exit(1); });
