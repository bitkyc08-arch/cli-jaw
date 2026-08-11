/**
 * `--raw` over a pipe: a machine protocol, not a TUI.
 *
 * Issue #275 scripts this as `echo '{"type":"message","text":"hi"}' | jaw chat --raw`
 * and calls it "JSON protocol mode (for UI integration)". The interactive
 * branches cannot serve that: they call setRawMode() (impossible on a pipe),
 * print a welcome banner, and wrap server frames in ANSI dim codes. Routing a
 * pipe through the readline mode was no better — it submitted the JSON text as
 * a literal user prompt and exited 0 at EOF before any answer arrived.
 *
 * Contract implemented here:
 *   stdin  — one JSON object per line (NDJSON). {"type":"message","text":"..."}
 *            is sent as a prompt. A bare non-JSON line is also accepted as
 *            prompt text, since the issue reporter used the CLI both ways.
 *   stdout — one raw server frame per line, verbatim, no ANSI and no prefix.
 *   exit   — 0 only after the final turn completes; 1 on protocol/transport
 *            failure. EOF on stdin does NOT end the run while a turn is in
 *            flight: a machine caller pipes input and then waits for output.
 */
import type { TuiContext } from './types.js';

interface RawPipeLine {
    type?: unknown;
    text?: unknown;
    prompt?: unknown;
}

function emit(payload: unknown): void {
    process.stdout.write(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
}

/** Extract prompt text from one input line, or null when the line carries none. */
function promptFromLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{')) return trimmed;   // bare text is accepted too
    let parsed: RawPipeLine;
    try {
        parsed = JSON.parse(trimmed) as RawPipeLine;
    } catch {
        return trimmed;
    }
    const text = typeof parsed.text === 'string' ? parsed.text
        : typeof parsed.prompt === 'string' ? parsed.prompt
            : null;
    return text && text.trim() ? text : null;
}

export async function runRawPipeMode(ctx: TuiContext): Promise<void> {
    const { ws } = ctx;

    let pending = 0;          // turns submitted but not yet finished
    let stdinDone = false;
    let settled = false;

    const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already closed */ }
        process.exit(code);
    };

    const maybeFinish = (): void => {
        if (stdinDone && pending === 0) finish(0);
    };

    ws.on('message', (data: unknown) => {
        const raw = String(data);
        emit(raw);                       // verbatim frame, no decoration
        try {
            const parsed = JSON.parse(raw) as { type?: unknown };
            // agent_done is the turn terminator the interactive handler also
            // treats as end-of-turn.
            if (parsed.type === 'agent_done' && pending > 0) {
                pending -= 1;
                maybeFinish();
            }
        } catch { /* non-JSON frames are still forwarded, just not counted */ }
    });

    // ChatChannel exposes only 'message' and 'close'. A transport failure
    // therefore surfaces as an early close: closing while turns are still in
    // flight means the caller never got its answer, so that is exit 1.
    ws.on('close', () => {
        if (pending > 0) emit({ type: 'error', error: 'channel closed before the turn completed' });
        finish(pending > 0 ? 1 : 0);
    });

    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const prompt = promptFromLine(line);
            if (prompt) {
                pending += 1;
                ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
            }
            newline = buffer.indexOf('\n');
        }
    });

    process.stdin.on('end', () => {
        const prompt = buffer ? promptFromLine(buffer) : null;
        if (prompt) {
            pending += 1;
            ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
        }
        stdinDone = true;
        maybeFinish();
    });
}
