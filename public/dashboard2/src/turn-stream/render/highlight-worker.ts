// 082 §3.1/§3.6 — highlight worker BOOTSTRAP. Deliberately tiny: it carries
// zero @shikijs bytes. The main thread sends the emitted shiki-runtime module
// URL in the init message and the worker imports that SAME chunk at runtime,
// so grammars/runtime are bundled exactly once. Tokenization output is RAW
// untrusted html — the main thread sanitizes before cache/DOM commit
// (DOMPurify needs a DOM, which workers do not have).
import type { HighlightRequest } from './code-block-contract.js';

export interface HighlightWorkerInit { kind: 'init'; moduleUrl: string }
export interface HighlightWorkerRequest { kind: 'request'; id: number; request: HighlightRequest }
export type HighlightWorkerMessage = HighlightWorkerInit | HighlightWorkerRequest;
export interface HighlightWorkerResult { id: number; generation: number; rawHtml: string | null; language: string; error?: string }

type RuntimeModule = {
    tokenizeCode(code: string, language: string): Promise<string>;
    escapeHighlightHtml(value: string): string;
};

interface ModuleWorkerScope { onmessage: ((event: MessageEvent<HighlightWorkerMessage>) => void) | null; postMessage(value: HighlightWorkerResult): void }
const workerScope = globalThis as unknown as Partial<ModuleWorkerScope>;
if (typeof document === 'undefined' && typeof workerScope.postMessage === 'function') {
    let runtimePromise: Promise<RuntimeModule> | null = null;
    // requests may arrive before the init message (main thread resolves the
    // runtime module URL asynchronously) — buffer them behind this gate
    let releaseInit: (() => void) | null = null;
    const initArrived = new Promise<void>(resolve => { releaseInit = resolve; });
    let queue = Promise.resolve();
    workerScope.onmessage = (event: MessageEvent<HighlightWorkerMessage>) => {
        const message = event.data;
        if (message.kind === 'init') {
            runtimePromise ??= import(/* @vite-ignore */ message.moduleUrl) as Promise<RuntimeModule>;
            releaseInit?.();
            return;
        }
        queue = queue.then(async () => {
            const { id, request } = message;
            try {
                await initArrived;
                if (!runtimePromise) throw new Error('highlight worker init failed');
                const runtime = await runtimePromise;
                const rawHtml = await runtime.tokenizeCode(request.code, request.language);
                workerScope.postMessage?.({ id, generation: request.generation, rawHtml, language: request.language });
            } catch (error) {
                workerScope.postMessage?.({
                    id, generation: request.generation, rawHtml: null, language: request.language,
                    error: error instanceof Error ? error.message : 'Highlight failed',
                });
            }
        }).catch(() => undefined);
    };
}
