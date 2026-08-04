import { settings } from '../core/config.js';
import { getActiveChatSession, resolveOrCreateRemoteSession } from '../core/chat-sessions.js';
import { channelGateOn } from '../orchestrator/scope.js';
import { submitMessage, type SubmitResult } from '../orchestrator/gateway.js';
import { sessionLanes } from '../orchestrator/session-lanes.js';
import { buildRemoteBindingKey } from '../messaging/session-key.js';
import type { RemoteTarget } from '../messaging/types.js';

const ingressTails = new Map<string, Promise<void>>();
const controllers = new Set<AbortController>();
const tracked = new Set<Promise<void>>();
const downloadWaiters: Array<() => void> = [];
let activeDownloads = 0;
let generation = 0;
let resetting = false;

function downloadLimit(): number {
    const value = Number(settings["slack"]?.inboundDownloadConcurrency ?? 6);
    return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 6;
}

function pumpDownloads(): void {
    while (activeDownloads < downloadLimit()) {
        const start = downloadWaiters.shift();
        if (!start) break;
        activeDownloads += 1;
        start();
    }
}

export function withSlackDownloadSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (resetting || signal?.aborted) return Promise.reject(new Error('ingress_cancelled'));
    return new Promise<T>((resolve, reject) => {
        let started = false;
        const start = () => {
            started = true;
            signal?.removeEventListener('abort', onAbort);
            void task().then(resolve, reject).finally(() => {
                activeDownloads -= 1;
                pumpDownloads();
            });
        };
        const onAbort = () => {
            if (started) return;
            const index = downloadWaiters.indexOf(start);
            if (index >= 0) downloadWaiters.splice(index, 1);
            reject(new Error('ingress_cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        downloadWaiters.push(start);
        pumpDownloads();
    });
}

export function slackIngressLaneKey(target: RemoteTarget): string {
    return settings["multiSession"]?.enabled === true && channelGateOn('slack')
        ? buildRemoteBindingKey(target)
        : 'default';
}

export function enqueueSlackIngress(
    laneKey: string,
    task: (signal: AbortSignal) => Promise<void>,
): void {
    if (resetting) return;
    const taskGeneration = generation;
    const controller = new AbortController();
    controllers.add(controller);
    const previous = ingressTails.get(laneKey);
    const run = async () => {
        if (controller.signal.aborted || taskGeneration !== generation) return;
        await task(controller.signal);
    };
    const result = previous ? previous.catch(() => undefined).then(run) : Promise.resolve().then(run);
    const tail = result.then(() => undefined, () => undefined);
    ingressTails.set(laneKey, tail);
    tracked.add(result);
    void result.catch(() => undefined).finally(() => {
        controllers.delete(controller);
        tracked.delete(result);
    });
    void tail.then(() => {
        if (ingressTails.get(laneKey) === tail) ingressTails.delete(laneKey);
    });
}

export type SlackRunContext = {
    scope: string;
    chatSessionId: string;
    requestId: string;
    remoteKey?: string;
};

export function admitSlackRun(params: {
    target: RemoteTarget;
    prompt: string;
    displayText: string;
    chatId: string;
    runReply: (ctx: SlackRunContext) => Promise<void>;
}): SubmitResult & { laneTail?: Promise<void> } {
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const gateEnabled = multiSessionEnabled && channelGateOn('slack');
    const remoteKey = gateEnabled ? buildRemoteBindingKey(params.target) : undefined;
    const chatSessionId = multiSessionEnabled && !gateEnabled
        ? 'default'
        : remoteKey ? resolveOrCreateRemoteSession(remoteKey) : getActiveChatSession();
    const scope = multiSessionEnabled && !gateEnabled ? 'default' : (remoteKey || 'default');
    const result = submitMessage(params.prompt, {
        origin: 'slack', displayText: params.displayText, skipOrchestrate: true,
        target: params.target, chatId: params.chatId,
        ...(remoteKey ? { remoteKey } : {}), chatSessionId, scope,
    });
    if (result.disposition !== 'new_run') return result;
    const session = result.sessionContext || { scope, chatSessionId, ...(remoteKey ? { remoteKey } : {}) };
    const laneTail = sessionLanes.run(session.scope, () => params.runReply({
        scope: session.scope,
        chatSessionId: session.chatSessionId,
        requestId: result.requestId || '',
        ...(session.remoteKey ? { remoteKey: session.remoteKey } : {}),
    }));
    return { ...result, laneTail };
}

export async function resetSlackIngress(): Promise<void> {
    resetting = true;
    generation += 1;
    for (const controller of controllers) controller.abort();
    const pending = [...tracked];
    if (pending.length) {
        const drain = Promise.allSettled(pending).then(() => undefined);
        await Promise.race([
            drain,
            new Promise<void>(resolve => setTimeout(resolve, 5_000)),
        ]);
        for (const promise of pending) void promise.catch(() => undefined);
    }
    ingressTails.clear();
    resetting = false;
}

export function slackIngressStats(): { lanes: number; activeDownloads: number } {
    return { lanes: ingressTails.size, activeDownloads };
}
