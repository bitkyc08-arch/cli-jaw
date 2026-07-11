// 048 Gate A — REAL 3-runtime parity smoke (claude / codex / agy).
// Boots a fresh jaw instance, runs a 10-tool-use turn per runtime, captures
// the LIVE turn-lifecycle SSE stream, then compares it against the RELOAD
// (history) rows: canonical (turnId,turnSeq,type,status) sequence must match
// and fidelity contracts must hold (claude/codex full, agy coarse/planner).
// Usage: npx tsx tests/smoke/dashboard2-3runtime-smoke.mts [--port 3979] [--clis claude,codex,agy]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const argPort = process.argv.find(a => a.startsWith('--port'));
const PORT = argPort ? Number(process.argv[process.argv.indexOf(argPort) + 1] ?? argPort.split('=')[1]) : 3979;
const argClis = process.argv.find(a => a.startsWith('--clis'));
const CLIS = (argClis ? (argClis.split('=')[1] ?? process.argv[process.argv.indexOf(argClis) + 1]) : 'claude,codex,agy').split(',');
const BASE = `http://127.0.0.1:${PORT}`;
const TURN_TIMEOUT_MS = 10 * 60_000;
const PROMPT = 'Run exactly 10 independent quick shell commands as separate tool calls '
    + '(date, pwd, whoami, uname -a, echo one, echo two, ls /tmp, hostname, id -u, uptime), '
    + 'then reply with one short summary line. Do not ask questions.';

interface TurnRow { turnId: string; turnSeq: number; type: string; status: string; fidelity: string | null; thinkingMarker: string | null }

const sseRows: TurnRow[] = [];
const sseDoneTexts: string[] = [];
let sseAbort: AbortController | null = null;

async function captureSse(): Promise<void> {
    sseAbort = new AbortController();
    const response = await fetch(`${BASE}/api/events`, { signal: sseAbort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line.startsWith('data:')) continue;
                    try {
                        const payload = JSON.parse(line.slice(5));
                        if (payload.topic === 'agent'
                            && ['turn_start', 'turn_segment', 'turn_end'].includes(payload.event)) {
                            sseRows.push({
                                turnId: payload.turnId, turnSeq: payload.turnSeq,
                                type: payload.type, status: payload.status,
                                fidelity: payload.fidelity ?? null,
                                thinkingMarker: payload.thinkingMarker ?? null,
                            });
                        }
                        if ((payload.event === 'agent_done' || payload.type === 'agent_done')
                            && typeof payload.text === 'string') {
                            sseDoneTexts.push(payload.text);
                        }
                    } catch { /* non-JSON keepalive */ }
                }
            }
        } catch { /* aborted */ }
    })();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}${path}`, init);
    return response.json() as Promise<T>;
}

function canonical(rows: TurnRow[]): string {
    return rows
        .map(r => `${r.turnId}#${r.turnSeq}:${r.type}:${r.status}`)
        .join('|');
}

function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function fidelityContractOk(cli: string, fidelities: string[], markers: string[]): boolean {
    if (cli === 'claude' || cli === 'codex') return fidelities.includes('full');
    if (cli === 'agy') return fidelities.includes('coarse') || markers.includes('planner');
    return fidelities.length > 0;
}

async function waitIdle(sinceMessageId: number): Promise<{ id: number; turn_id: string | null; content: string }> {
    const startedAt = Date.now();
    for (;;) {
        if (Date.now() - startedAt > TURN_TIMEOUT_MS) throw new Error('turn timeout');
        await new Promise(r => setTimeout(r, 4000));
        const page = await api<{ ok: boolean; data: Array<{ id: number; role: string; turn_id: string | null; content: string; turn_segments: TurnRow[] }> }>(
            '/api/messages?includeSegments=1&limit=50');
        const fresh = page.data.filter(m => m.id > sinceMessageId && m.role === 'assistant' && m.turn_id);
        for (const message of fresh) {
            const ended = message.turn_segments.some(s => s.type === 'turn_end');
            if (ended) return message;
        }
    }
}

async function main(): Promise<void> {
    console.log(`[smoke] starting jaw on :${PORT}`);
    const server = spawn('node', [join(ROOT, 'dist/bin/cli-jaw.js'), 'serve', `--${PORT}`], {
        stdio: 'ignore', detached: false, env: { ...process.env },
    });
    const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } sseAbort?.abort(); };
    process.on('exit', cleanup);
    // wait for health
    for (let i = 0; i < 60; i++) {
        try { await api('/api/settings'); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
        if (i === 59) throw new Error('server failed to boot');
    }
    await captureSse();

    const evidence: Record<string, unknown> = { port: PORT, startedAt: new Date().toISOString() };
    const results: Record<string, unknown> = {};
    for (const cli of CLIS) {
        console.log(`[smoke] runtime=${cli} — sending 10-tool-use prompt`);
        await api('/api/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cli }),
        });
        const before = await api<{ data: Array<{ id: number }> }>('/api/messages?limit=1');
        const sinceId = before.data[0]?.id ?? 0;
        const sseStart = sseRows.length;
        const doneStart = sseDoneTexts.length;
        await api('/api/message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: PROMPT }),
        });
        const message = await waitIdle(sinceId);
        await new Promise(r => setTimeout(r, 3000)); // drain trailing SSE
        const live = sseRows.slice(sseStart).filter(r => r.turnId === message.turn_id);
        const reload = await api<{ data: Array<{ id: number; turn_id: string | null; turn_segments: TurnRow[] }> }>(
            '/api/messages?includeSegments=1&limit=50');
        const persisted = reload.data.find(m => m.id === message.id)?.turn_segments ?? [];
        const liveCanonical = canonical([...live].sort((a, b) => a.turnSeq - b.turnSeq));
        const reloadCanonical = canonical(persisted);
        const toolRows = persisted.filter(r => r.type === 'tool');
        const fidelities = new Set(persisted.map(r => r.fidelity).filter(Boolean));
        const markers = new Set(persisted.map(r => r.thinkingMarker).filter(Boolean));
        const parity = liveCanonical === reloadCanonical && liveCanonical.length > 0;
        // body hash: LIVE final agent_done text vs RELOADED persisted content
        const liveDone = sseDoneTexts.slice(doneStart).pop() ?? null;
        const bodyHashLive = liveDone !== null ? sha(liveDone) : null;
        const bodyHashReload = sha(message.content);
        const bodyParity = bodyHashLive !== null && bodyHashLive === bodyHashReload;
        const toolGate = toolRows.length >= 10;
        const fidelityGate = fidelityContractOk(cli, [...fidelities] as string[], [...markers] as string[]);
        results[cli] = {
            turnId: message.turn_id,
            liveRows: live.length,
            persistedRows: persisted.length,
            toolRows: toolRows.length,
            parity,
            bodyParity,
            bodyHashLive,
            bodyHashReload,
            toolGate,
            fidelityGate,
            fidelities: [...fidelities],
            markers: [...markers],
            liveCanonical: liveCanonical.slice(0, 400),
            reloadCanonical: reloadCanonical.slice(0, 400),
        };
        console.log(`[smoke] ${cli}: parity=${parity} bodyParity=${bodyParity} tools=${toolRows.length}(>=10:${toolGate}) fidelityGate=${fidelityGate} fidelity=${[...fidelities].join(',')}`);
    }
    evidence.results = results;
    const outDir = join(ROOT, 'devlog/_plan/260711_manager_redesign_feature_migration/refs');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '048-gateA-3runtime-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('[smoke] evidence written to refs/048-gateA-3runtime-evidence.json');
    cleanup();
    const failed = Object.entries(results).filter(([, r]) => {
        const gate = r as { parity: boolean; bodyParity: boolean; toolGate: boolean; fidelityGate: boolean };
        return !(gate.parity && gate.bodyParity && gate.toolGate && gate.fidelityGate);
    });
    if (failed.length) {
        console.error('[smoke] GATE FAIL:', failed.map(([k]) => k).join(','));
        process.exit(1);
    }
    process.exit(0);
}

main().catch(error => { console.error('[smoke] fatal', error); process.exit(1); });
