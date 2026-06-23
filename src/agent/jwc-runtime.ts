// JawRuntime — in-process jwc coding-agent engine, resident in the cli-jaw server.
// One AgentSession per (cwd, chatSession) main slot, reused across turns; no child
// process, no NDJSON parse stack. Errors are isolated per turn — a thrown turn
// disposes+recreates the session so the server survives (M2 done ①).
//
// Design SoT: jawcode devlog 110.3 / 120.1 (session injection 안 A) / 130.2.
// Engine surface comes from `jawcode/sdk` (single import boundary, 160+ contract):
//   createAgentSession({ cwd, agentDir, hasUI:false, sessionManager })
//     → { session: AgentSession, eventBus }
//   session.prompt(text, { streamingBehavior?: "steer"|"followUp" })
//   session.subscribe(listener) → unsubscribe ; session.isStreaming ; session.dispose()
//
// The engine is loaded lazily by dynamic import so this module compiles before
// the jwc package is linked (100 in flight). Resolution order:
//   1. JWC_SDK_PATH env (absolute path to dist-node/sdk.js — dev/CI)
//   2. "jawcode/sdk" package export (separately installed package path)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapAgentEventToBus, type JwcAgentEvent } from './jwc-event-mapper.js';

// ── engine types (structural; avoids a hard dep before jwc is linked) ──
interface EngineSession {
    prompt(text: string, opts?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
    subscribe(listener: (event: JwcAgentEvent) => void): () => void;
    readonly isStreaming: boolean;
    abort?(): Promise<void>;
    dispose(): Promise<void>;
}
interface EngineSdk {
    createAgentSession(opts: {
        cwd: string;
        agentDir?: string;
        hasUI?: boolean;
        sessionManager?: unknown;
        modelPattern?: string;
        thinkingLevel?: string;
    }): Promise<{ session: EngineSession }>;
    SessionManager: {
        create(cwd: string, dir: string): unknown;
        continueRecent(cwd: string, dir: string): Promise<unknown>;
        getDefaultSessionDir(cwd: string, agentDir: string): string;
    };
}

let sdkPromise: Promise<EngineSdk> | null = null;
const DEFAULT_JWC_SDK_SPEC = 'jawcode/sdk';
const JWC_INSTALL_HINT =
    'cli-jaw does not bundle JWC. Run jaw jwc install, set the printed JWC_SDK_PATH, and verify with jaw jwc doctor. For source builds, set JWC_SDK_PATH=/absolute/path/to/jawcode/packages/jwc/dist-node/sdk.js (for example, /Users/jun/Developer/new/700_projects/jawcode/packages/jwc/dist-node/sdk.js). Remove optional JWC dependencies with jaw jwc clean.';

function formatSdkLoadError(spec: string, err: unknown): Error {
    const detail = err instanceof Error ? err.message : String(err);
    return new Error(`JWC SDK is not available from ${spec}. ${JWC_INSTALL_HINT} Original error: ${detail}`);
}

function loadSdk(): Promise<EngineSdk> {
    if (sdkPromise) return sdkPromise;
    const override = process.env['JWC_SDK_PATH'];
    const spec = override && override.trim() ? override.trim() : DEFAULT_JWC_SDK_SPEC;
    sdkPromise = (import(spec) as Promise<EngineSdk>).catch(err => {
        sdkPromise = null;
        throw formatSdkLoadError(spec, err);
    });
    return sdkPromise;
}

/** Agent config dir for the embedded engine. jaw mode (resident) reuses the
 *  standalone jwc store `~/.jwc/agent` so the user's existing login/skills/memory
 *  carry over (111 §e decision 0; 130.2). Code mode (112.3 ACP) keeps an isolated
 *  dir instead. CLI_JAW_JWC_AGENT_DIR overrides for tests/CI. */
function jwcAgentDir(): string {
    const override = process.env['CLI_JAW_JWC_AGENT_DIR'];
    if (override && override.trim()) return override.trim();
    return join(homedir(), '.jwc', 'agent');
}

export interface JawRunResult {
    text: string;
    code: number;
}

interface RuntimeSlot {
    session: EngineSession;
    cwd: string;
    unsubscribe: () => void;
}

class JawRuntime {
    #slot: RuntimeSlot | null = null;
    #inFlight: Promise<JawRunResult> | null = null;
    /** Live-run scope of the turn in flight; the event subscription reads this so
     *  streamed text/tools accumulate into the right scope for persistence. */
    #liveScope: string | undefined;

    /** Bind the live-run scope of the next turn (set by the spawn branch). */
    setLiveScope(scope: string | undefined): void {
        this.#liveScope = scope;
    }

    async abort(): Promise<void> {
        if (this.#slot?.session.abort) {
            await this.#slot.session.abort();
        }
    }

    /** True while a turn is streaming or settling — feeds isAgentBusy(). */
    get busy(): boolean {
        return !!this.#inFlight || (this.#slot?.session.isStreaming ?? false);
    }

    #modelPattern: string | undefined;
    #thinkingLevel: string | undefined;

    setModelPattern(pattern: string | undefined): void {
        if (pattern === this.#modelPattern) return;
        this.#modelPattern = pattern;
        if (this.#slot) void this.#disposeSlot();
    }

    setThinkingLevel(level: string | undefined): void {
        if (level === this.#thinkingLevel) return;
        this.#thinkingLevel = level;
        if (this.#slot) void this.#disposeSlot();
    }

    async #ensureSlot(cwd: string): Promise<RuntimeSlot> {
        if (this.#slot && this.#slot.cwd === cwd) return this.#slot;
        if (this.#slot) await this.#disposeSlot();
        const sdk = await loadSdk();
        const agentDir = jwcAgentDir();
        process.env['JWC_BRAND_NAME'] ??= 'jwc';
        const dir = sdk.SessionManager.getDefaultSessionDir(cwd, agentDir);
        let sessionManager: unknown;
        try {
            sessionManager = await sdk.SessionManager.continueRecent(cwd, dir);
        } catch {
            sessionManager = sdk.SessionManager.create(cwd, dir);
        }
        const { session } = await sdk.createAgentSession({
            cwd, agentDir, hasUI: false, sessionManager,
            ...(this.#modelPattern ? { modelPattern: this.#modelPattern } : {}),
            ...(this.#thinkingLevel ? { thinkingLevel: this.#thinkingLevel } : {}),
        });
        const unsubscribe = session.subscribe(event =>
            mapAgentEventToBus(event, { cwd, sessionId: cwd, liveScope: this.#liveScope }),
        );
        this.#slot = { session, cwd, unsubscribe };
        return this.#slot;
    }

    async #disposeSlot(): Promise<void> {
        const slot = this.#slot;
        this.#slot = null;
        if (!slot) return;
        try { slot.unsubscribe(); } catch { /* ignore */ }
        try { await slot.session.dispose(); } catch { /* ignore */ }
    }

    /** Run a fresh turn. Resolves with the spawn-compatible { text, code }. */
    prompt(cwd: string, text: string): Promise<JawRunResult> {
        const run = this.#runTurn(cwd, () => this.#slot!.session.prompt(text));
        this.#inFlight = run;
        return run;
    }

    /** Steer the live turn (no kill-respawn); falls back to a normal turn when idle. */
    async steer(cwd: string, text: string): Promise<void> {
        const slot = await this.#ensureSlot(cwd);
        if (slot.session.isStreaming) {
            await slot.session.prompt(text, { streamingBehavior: 'steer' });
        } else {
            await this.prompt(cwd, text);
        }
    }

    async followUp(cwd: string, text: string): Promise<void> {
        const slot = await this.#ensureSlot(cwd);
        // Track in-flight so busy() is true even on the idle followUp path (the
        // session may auto-continue from assistant-ended state). Without this,
        // isAgentBusy() under-reports between dispatch and stream start.
        const run = (async () => {
            await slot.session.prompt(text, { streamingBehavior: 'followUp' });
            return { text: '', code: 0 } as JawRunResult;
        })();
        this.#inFlight = run;
        try { await run; } finally { this.#inFlight = null; }
    }

    async #runTurn(cwd: string, fn: () => Promise<void>): Promise<JawRunResult> {
        try {
            await this.#ensureSlot(cwd);
            await fn();
            return { text: '', code: 0 };
        } catch (err) {
            // Per-turn isolation: drop the session so the next turn rebuilds it.
            await this.#disposeSlot();
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `❌ jwc runtime error: ${msg}`, code: 1 };
        } finally {
            this.#inFlight = null;
        }
    }

    async dispose(): Promise<void> {
        await this.#disposeSlot();
    }
}

export const jawRuntime = new JawRuntime();
