#!/usr/bin/env node
/**
 * `jaw ask` — one prompt in, one answer out, no TTY required.
 *
 * Issue #276: on a headless host there was no CLI path that could send a prompt
 * and get the answer back. The TUI needs a terminal, and `POST /api/message`
 * only ACKs — it returns a requestId and leaves the caller to figure out when
 * the work finished.
 *
 * Two things make this correct, and both are easy to get wrong:
 *
 * 1. SUBSCRIBE BEFORE SUBMITTING. The event stream does not replay for a
 *    client that connects without a cursor, so posting first and connecting
 *    second loses any answer that arrives in between — which is exactly what
 *    happens on a fast reply or an immediate error.
 *
 * 2. WAIT ON `request_settled`, NOT `orchestrate_done`. A busy server steers
 *    the prompt into the turn already running, and that turn never emits a
 *    completion event for the new id. Waiting on orchestrate_done hangs there
 *    until timeout. The settlement contract reports `steered` instead, so this
 *    command can say what actually happened.
 */
import { getServerUrl } from '../../src/core/config.js';
import { authHeaders } from '../../src/cli/api-auth.js';

interface AskOptions {
    prompt: string;
    port: string;
    json: boolean;
    timeoutMs: number;
}

interface SettleFrame {
    /** SSE frames name the kind in `event`; `type` is the WebSocket spelling. */
    event?: string;
    type?: string;
    requestId?: string;
    outcome?: string;
    text?: string;
    error?: string;
    mergedInto?: string;
    reason?: string;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_TIMEOUT = 124;

function usage(): never {
    console.error('Usage: jaw ask "<prompt>"           send a prompt and print the answer');
    console.error('       echo "<prompt>" | jaw ask -  read the prompt from stdin');
    console.error('');
    console.error('  --json            print one JSON object instead of plain text');
    console.error('  --timeout <sec>   give up after N seconds (default 300)');
    console.error('  --port <port>     server port (default from settings)');
    process.exit(EXIT_USAGE);
}

function parseArgs(argv: string[]): AskOptions {
    const rest: string[] = [];
    let port = '';
    let json = false;
    let timeoutSec = 300;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') { json = true; continue; }
        if (arg === '--timeout') { timeoutSec = Number(argv[++i]) || timeoutSec; continue; }
        if (arg === '--port') { port = String(argv[++i] ?? ''); continue; }
        if (arg === '--help' || arg === '-h') usage();
        rest.push(arg);
    }
    return { prompt: rest.join(' '), port, json, timeoutMs: Math.max(1, timeoutSec) * 1000 };
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Open the stream and resolve once the server has acknowledged the connection,
 * so the caller can submit knowing nothing will be missed. Frames are handed to
 * `onFrame` as they arrive.
 */
async function openEventStream(
    apiUrl: string,
    onFrame: (frame: SettleFrame) => void,
    signal: AbortSignal,
): Promise<void> {
    const res = await fetch(`${apiUrl}/api/events`, {
        headers: { ...authHeaders(), Accept: 'text/event-stream' },
        signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let sep = buffer.indexOf('\n\n');
                while (sep !== -1) {
                    const block = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    for (const line of block.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trim();
                        if (!payload) continue;
                        try { onFrame(JSON.parse(payload) as SettleFrame); } catch { /* not our frame */ }
                    }
                    sep = buffer.indexOf('\n\n');
                }
            }
        } catch { /* aborted or closed; the caller owns the outcome */ }
    })();
}

/** Exported for testing: outcome -> exit code is the contract scripts depend on. */
export function exitCodeForOutcome(outcome: string | undefined): number {
    // `steered` is a success: the prompt reached a turn that was already
    // running. There is no separate answer, but nothing failed either.
    return outcome === 'completed' || outcome === 'steered' ? EXIT_OK : EXIT_FAILED;
}

export function renderOutcome(frame: SettleFrame, json: boolean): number {
    if (json) {
        console.log(JSON.stringify({
            ok: frame.outcome === 'completed' || frame.outcome === 'steered',
            requestId: frame.requestId,
            outcome: frame.outcome,
            ...(frame.text !== undefined ? { text: frame.text } : {}),
            ...(frame.error !== undefined ? { error: frame.error } : {}),
            ...(frame.mergedInto !== undefined ? { mergedInto: frame.mergedInto } : {}),
        }));
    } else {
        switch (frame.outcome) {
            case 'completed':
                if (frame.text) console.log(frame.text);
                break;
            case 'steered':
                // Honest reporting matters here: the prompt reached a turn that
                // was already running, so there is no separate answer to wait for.
                console.error('Delivered to the in-progress turn; no separate reply.');
                break;
            case 'failed':
                console.error(frame.error || 'request failed');
                break;
            default:
                console.error(`request ${frame.outcome}${frame.reason ? `: ${frame.reason}` : ''}`);
        }
    }
    return exitCodeForOutcome(frame.outcome);
}

/** Exported for testing: SSE says `event`, the WebSocket fallback says `type`. */
export function isSettlementFrame(frame: SettleFrame): boolean {
    return (frame.event ?? frame.type) === 'request_settled';
}

async function main(): Promise<number> {
    const opts = parseArgs(process.argv.slice(3));
    const prompt = opts.prompt === '-' || !opts.prompt ? await readStdin() : opts.prompt;
    if (!prompt) usage();

    const apiUrl = getServerUrl(opts.port || undefined);
    const controller = new AbortController();

    // Track the id we care about. It is only known after the POST, so frames
    // that arrive before then are buffered rather than dropped.
    let requestId: string | null = null;
    const buffered: SettleFrame[] = [];
    let settle: (frame: SettleFrame) => void = () => { /* replaced below */ };

    const settled = new Promise<SettleFrame>((resolve) => { settle = resolve; });

    const onFrame = (frame: SettleFrame): void => {
        if (!isSettlementFrame(frame)) return;
        if (requestId === null) { buffered.push(frame); return; }
        if (frame.requestId === requestId) settle(frame);
    };

    try {
        await openEventStream(apiUrl, onFrame, controller.signal);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) console.log(JSON.stringify({ ok: false, error: `cannot reach ${apiUrl}`, detail: message }));
        else console.error(`Cannot reach ${apiUrl} — run \`cli-jaw serve\` first.`);
        return EXIT_FAILED;
    }

    const res = await fetch(`${apiUrl}/api/message`, {
        method: 'POST',
        headers: { ...authHeaders({ 'Content-Type': 'application/json' }) },
        body: JSON.stringify({ prompt }),
    }).catch((err: Error) => err);

    if (res instanceof Error) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: res.message }));
        else console.error(res.message);
        controller.abort();
        return EXIT_FAILED;
    }

    const body = await res.json().catch(() => ({})) as { ok?: boolean; requestId?: string; error?: string };
    if (!res.ok || !body.requestId) {
        const error = body.error || `HTTP ${res.status}`;
        if (opts.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(error);
        controller.abort();
        return EXIT_FAILED;
    }

    requestId = body.requestId;
    // Replay anything that settled between connecting and learning our id.
    for (const frame of buffered) {
        if (frame.requestId === requestId) settle(frame);
    }

    const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), opts.timeoutMs).unref?.();
    });

    const outcome = await Promise.race([settled, timeout]);
    controller.abort();

    if (outcome === 'timeout') {
        if (opts.json) console.log(JSON.stringify({ ok: false, requestId, error: 'timeout' }));
        else console.error(`Timed out after ${opts.timeoutMs / 1000}s (request ${requestId} may still be running).`);
        return EXIT_TIMEOUT;
    }
    return renderOutcome(outcome, opts.json);
}

// Only run when invoked as the command, so tests can import the pure helpers
// without the module trying to reach a server.
const isEntryPoint = process.argv[1]?.endsWith('cli-jaw.js')
    || process.argv[1]?.endsWith('cli-jaw.ts')
    || process.argv[1]?.endsWith('ask.js')
    || process.argv[1]?.endsWith('ask.ts');
if (isEntryPoint) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch((err: Error) => {
            console.error(err.message);
            process.exitCode = EXIT_FAILED;
        });
}
