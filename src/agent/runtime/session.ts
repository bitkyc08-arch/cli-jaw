import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventBody, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';

export interface RuntimePrompt {
    text: string;
    images?: ReadonlyArray<{ mimeType: string; data: string }>;
}
export type RuntimeTurnResult = RuntimeTurnOutcome;
export interface RuntimeInputAcceptance {
    mode: RuntimeCapabilities['steer'];
    accepted: boolean;
    turnId: string;
    reason?: string;
}
export interface NativeRuntimeSession {
    readonly alive: boolean;
    readonly capabilities: RuntimeCapabilities;
    readonly nativeSessionId: string;
    send(prompt: RuntimePrompt, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeTurnResult>;
    /** Main-only completion handshake; absent on adapters using immediate terminals. */
    claimTurnOutcome?(turnId: string): RuntimeTurnOutcome | null;
    /** Accepts the captured logical terminal, not proof that a journal write succeeded. */
    finalizeTurn?(turnId: string, end: Extract<RuntimeEventBody, { kind: 'turn-end' }>): boolean;
    steer(prompt: RuntimePrompt): Promise<RuntimeInputAcceptance>;
    cancel(): Promise<void>;
    respond(requestId: string, response: unknown): Promise<void>;
    close(): Promise<void>;
}
