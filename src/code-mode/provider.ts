import type { RuntimeEvent, RuntimeEventBody, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import type { RuntimeEventContext } from '../agent/runtime/events.js';
import type { RuntimeRequests } from '../agent/runtime/requests.js';
import type { RuntimeTranscriptObserver } from '../agent/runtime/projection.js';
import type { CodePermissionMode, CodeProviderCatalog, CodeProviderId } from './wire.js';

export interface CodeTurnContext extends RuntimeEventContext {
    epoch: number;
    isCurrent(): boolean;
}

/** Native adapters receive captured Code ownership, never a Jaw runtime lease. */
export interface CodeOpenOptions {
    sessionId: string;
    cwd: string;
    model: string;
    effort: string | null;
    permissionMode: CodePermissionMode;
    nativeCursor: string | null;
    signal: AbortSignal;
    registry: RuntimeRequests;
    getTurnContext(): CodeTurnContext;
    record(context: RuntimeEventContext, body: RuntimeEventBody): RuntimeEvent | null;
    transcript(context: RuntimeEventContext): RuntimeTranscriptObserver;
    resolveTranscriptParent(context: RuntimeEventContext, nativeToolRef: string): string | null;
    onNativeCursor(cursor: string | null, context?: RuntimeEventContext): void;
    onExit(error: Error | null): void;
}

export interface CodeProviderSession {
    readonly nativeSessionId: string;
    readonly alive: boolean;
    send(text: string): Promise<RuntimeTurnOutcome>;
    cancel(): Promise<void>;
    close(): Promise<void>;
}

export interface CodeProvider {
    readonly id: CodeProviderId;
    describe(): CodeProviderCatalog;
    open(options: CodeOpenOptions): Promise<CodeProviderSession>;
}

export type CodeProviders = Readonly<Record<CodeProviderId, CodeProvider>>;
