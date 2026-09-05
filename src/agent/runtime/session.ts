import type { RuntimeCapabilities, RuntimeEvent, RuntimeTurnOutcome } from '../../shared/runtime-contract.js';

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
    steer(prompt: RuntimePrompt): Promise<RuntimeInputAcceptance>;
    cancel(): Promise<void>;
    respond(requestId: string, response: unknown): Promise<void>;
    close(): Promise<void>;
}
