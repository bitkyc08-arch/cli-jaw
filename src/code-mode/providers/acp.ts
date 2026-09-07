import { spawn, type ChildProcess } from 'node:child_process';
import { AcpRuntimeSession } from '../../agent/runtime/acp/runtime-session.js';
import type { AcpSession } from '../../agent/runtime/acp/session.js';
import { hasChildExited, ownProcess } from '../../agent/spawn/process-kill.js';
import type { RuntimeEventBody } from '../../shared/runtime-contract.js';
import type { CodeOpenOptions, CodeProviderSession, CodeRuntimeResource, CodeTurnContext } from '../provider.js';
import type { CodeProviderCatalog } from '../wire.js';

export interface CodeProviderDependencies {
    describe(): CodeProviderCatalog;
    binary(): string;
    environment(): NodeJS.ProcessEnv;
}

export const CODE_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const CODE_CHILD_CLOSE_MS = 6000;

function childResource(child: ChildProcess): CodeRuntimeResource {
    let closing: Promise<void> | undefined;
    return {
        get closed() { return hasChildExited(child); },
        close() {
            // Defer acquisition so the native constructor installs its original
            // process policy synchronously after spawn returns. ownProcess shares it.
            closing ??= Promise.resolve().then(async () => {
                if (hasChildExited(child)) return;
                const owned = ownProcess(child);
                let resolveExit!: () => void;
                const exited = new Promise<void>(resolve => { resolveExit = resolve; });
                const receipt = () => { if (hasChildExited(child)) resolveExit(); };
                child.on('exit', receipt); child.on('close', receipt);
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    owned.terminate('shutdown'); receipt();
                    await Promise.race([exited, new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => {
                            if (hasChildExited(child)) resolveExit();
                            else reject(new Error('code_native_cleanup_unconfirmed'));
                        }, CODE_CHILD_CLOSE_MS);
                    })]);
                } finally {
                    if (timer) clearTimeout(timer);
                    child.off('exit', receipt); child.off('close', receipt);
                }
            });
            return closing;
        },
    };
}

/** Preserve spawn's overloads and exact child; registration precedes native initialization. */
export function codeOwnedSpawn(options: CodeOpenOptions, nativeSpawn: typeof spawn = spawn): typeof spawn {
    return ((...args: Parameters<typeof spawn>) => {
        const child = nativeSpawn(...args);
        const resource = childResource(child);
        try { options.onResource(resource); }
        catch (error) {
            void resource.close().catch(() => console.warn('[code:acp] cleanup_unconfirmed'));
            throw error;
        }
        return child;
    }) as typeof spawn;
}

export function captureCodeContext(options: CodeOpenOptions): Readonly<CodeTurnContext> {
    const context = Object.freeze({ ...options.getTurnContext() });
    if (context.audience !== 'internal' || context.sessionId !== options.sessionId || !context.isCurrent()) {
        throw new Error('code_provider_invalid_owner');
    }
    return context;
}

export function admitCodeOpen(options: CodeOpenOptions, dependencies: CodeProviderDependencies): void {
    if (options.signal.aborted) throw new Error('code_provider_open_aborted');
    if (!dependencies.describe().capabilities.permissionModes.includes(options.permissionMode)) {
        throw new Error('code_provider_policy_unsupported');
    }
    captureCodeContext(options);
}

/** The protocol owns its process and approvals; Code supplies all persistence. */
export async function openCodeAcp(options: CodeOpenOptions, provider: 'cursor' | 'grok',
    create: (failed: (error: Error) => void) => Promise<AcpSession>,
    resultUsage?: (result: Record<string, unknown>) => Extract<RuntimeEventBody, { kind: 'usage' }> | null,
): Promise<CodeProviderSession> {
    const opening = captureCodeContext(options);
    let exited = false, closingRequested = false;
    const exit = (error: Error | null) => {
        if (exited) return;
        exited = true;
        options.onExit(error);
    };
    const protocol = await create(error => { if (!closingRequested) exit(error); });
    const runtime = new AcpRuntimeSession(protocol, {
        provider, registry: options.registry,
        capabilities: { transport: 'native', steer: 'restart', resume: true, tools: true,
            toolOutput: true, approvals: true, questions: false, images: false, subagents: false },
        getTurnContext: () => captureCodeContext(options),
        record: options.record, transcript: options.transcript,
        ...(resultUsage ? { resultUsage } : {}),
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closing) return closing;
        closingRequested = true;
        options.signal.removeEventListener('abort', abort);
        closing = Promise.resolve().then(() => runtime.close()).then(() => exit(null), error => {
            exit(error instanceof Error ? error : new Error('code_provider_close_failed'));
            throw error;
        });
        return closing;
    };
    const abort = () => { void close().catch(() => { /* close reports the owned failure */ }); };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal.aborted || !opening.isCurrent() || !runtime.alive || !runtime.nativeSessionId) {
            throw new Error('code_provider_open_aborted');
        }
        if (options.nativeCursor !== null && runtime.nativeSessionId !== options.nativeCursor) {
            throw new Error('code_provider_resume_identity_changed');
        }
        options.onNativeCursor(runtime.nativeSessionId, opening);
        return {
            get nativeSessionId() { return runtime.nativeSessionId; },
            get alive() { return !closing && runtime.alive; },
            get closed() { return hasChildExited(protocol.child); },
            async send(text) {
                if (closingRequested) throw new Error('code_provider_closed');
                return runtime.send({ text }, () => {});
            },
            cancel: () => closing ?? runtime.cancel(), close,
        };
    } catch (error) { await close(); throw error; }
}
