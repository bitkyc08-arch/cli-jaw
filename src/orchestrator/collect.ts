// ─── orchestrateAndCollect ──────────────────────────
// Extracted from bot.ts. Wraps orchestrate call and collects
// results via broadcast listener into a Promise<string>.
// Used by heartbeat.ts and bot.ts for TG orchestration.

import { addBroadcastListener, removeBroadcastListener } from '../core/bus.js';
import {
    orchestrate, orchestrateContinue, orchestrateReset,
    isContinueIntent, isResetIntent,
} from './pipeline.js';
import { t } from '../core/i18n.js';
import { isRenderableError } from '../messaging/error-block.js';
import type { RuntimeLivenessIdentity, RuntimeTurnOutcome } from '../shared/runtime-contract.js';
import { settings } from '../core/config.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { resolveExecutionBinding } from './scope.js';

export interface CollectedOrchestrateResult {
    text: string;
    data: Record<string, any> & {
        agyPlannerOnly?: boolean;
        agyCheckpointSeen?: boolean;
        runtimeFinality?: 'present' | 'absent';
        runtimeStatus?: RuntimeTurnOutcome['status'];
    };
}

/** Like orchestrateAndCollect, but resolves the full orchestrate_done payload
 *  (e.g. elicitationSpecs for telegram inline keyboards) alongside the text. */
export function orchestrateAndCollectData(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<CollectedOrchestrateResult> {
    meta = { ...meta };
    return new Promise((resolve) => {
        const binding = resolveExecutionBinding({
            ...meta,
            chatSessionId: meta['chatSessionId'] === undefined ? meta['sessionId'] : meta['chatSessionId'],
            persistedScopeId: meta['remoteKey'],
            captured: currentSessionScope() ?? null,
            activeChatSessionId: getActiveChatSession(),
            multiSessionEnabled: settings['multiSession']?.enabled === true,
        });
        const runMeta = { ...meta, ...binding, origin: meta['origin'] || 'web',
            _onRuntimeActivity: onRuntimeActivity };
        const requestId = meta['requestId'] || undefined;
        let collected = '';
        let ownTerminalDiagnostic = '';
        let nativeSeen = false;
        let settled = false;
        let runtimeActive = true;
        let nativeRunId: string | undefined;
        let timeout: ReturnType<typeof setTimeout>;
        const IDLE_TIMEOUT = 1200000;

        function resetTimeout() {
            if (settled) return;
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                settled = true;
                runtimeActive = false;
                removeBroadcastListener(handler);
                // This is a collector/application timeout, not a runtime
                // completion. Keep data empty: an observed agent_done does not
                // authorize synthesizing model-final/status tags here. Once a
                // native run is known, only its correlated classified diagnostic
                // may replace the existing timeout copy, never global collected.
                resolve({ text: (nativeSeen ? ownTerminalDiagnostic : collected) || t('tg.timeout', {}, locale), data: {} });
            }, IDLE_TIMEOUT);
        }

        function onRuntimeActivity(identity: RuntimeLivenessIdentity) {
            if (settled || !runtimeActive || identity.scope !== binding.scope
                || identity.sessionId !== binding.chatSessionId || identity.origin !== runMeta.origin
                || identity.requestId !== requestId || !identity.runId.trim()
                || (nativeRunId !== undefined && identity.runId !== nativeRunId)) return;
            nativeRunId = identity.runId;
            nativeSeen = true;
            resetTimeout();
        }

        const matchesNativeIdentity = (data: Record<string, unknown>): boolean => {
            return (!requestId || data['requestId'] === requestId)
                && data['scope'] === binding.scope
                && data['sessionId'] === binding.chatSessionId
                && data['origin'] === runMeta.origin
                && (nativeRunId === undefined || data['traceRunId'] === nativeRunId);
        };
        const handler = (type: string, data: Record<string, any>) => {
            if (settled) return;
            const native = (data['runtimeFinality'] === 'present' || data['runtimeFinality'] === 'absent')
                && (data['runtimeStatus'] === 'done' || data['runtimeStatus'] === 'error' || data['runtimeStatus'] === 'stopped');
            // A mismatched native terminal must not remove this request's
            // listener, extend its timeout, or contaminate its diagnostic.
            if (native && !matchesNativeIdentity(data)) return;
            if (native && (type === 'agent_done' || type === 'orchestrate_done')) nativeSeen = true;
            if (native && type === 'agent_done') runtimeActive = false;
            // Live assistant chunks arrive as agent_output (Web UI + spawn.ts); legacy alias agent_chunk.
            if (type === 'agent_chunk' || type === 'agent_output' || type === 'agent_tool' ||
                type === 'agent_status' || type === 'agent_retry' ||
                type === 'agent_done' || type === 'agent_fallback' ||
                type === 'round_start' || type === 'round_done') {
                resetTimeout();
            }
            // agent_output is the live stream event; agent_done remains authoritative.
            if (type === 'agent_done' && data["error"] && data["text"]) {
                collected = collected || data["text"];
                if (typeof meta['requestId'] === 'string' && meta['requestId']
                    && matchesNativeIdentity(data) && isRenderableError(data)
                    && typeof data['text'] === 'string' && data['text'].trim()) {
                    ownTerminalDiagnostic = ownTerminalDiagnostic || data['text'];
                }
            }
            if (type === 'orchestrate_done') {
                // Filter by requestId (strongest), then origin, then chatId
                if (meta?.["requestId"] && data?.["requestId"] && data["requestId"] !== meta["requestId"]) return;
                if (meta?.["origin"] && data?.["origin"] && data["origin"] !== meta["origin"]) return;
                if (!meta?.["requestId"] && meta?.["chatId"] && data?.["chatId"] && data["chatId"] !== meta["chatId"]) return;
                clearTimeout(timeout);
                settled = true;
                runtimeActive = false;
                removeBroadcastListener(handler);
                const terminalText = typeof data['text'] === 'string' && data['text'].trim() ? data['text'] : '';
                resolve({ text: native
                    ? terminalText || ownTerminalDiagnostic || t('tg.noResponse', {}, locale)
                    : data["text"] || collected || t('tg.noResponse', {}, locale), data });
            }
        };
        addBroadcastListener(handler);
        resetTimeout();
        const run = isResetIntent(prompt)
            ? orchestrateReset(runMeta)
            : isContinueIntent(prompt)
                ? orchestrateContinue(runMeta)
                : orchestrate(prompt, runMeta);
        Promise.resolve(run).catch(err => {
            if (settled) return;
            settled = true;
            runtimeActive = false;
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve({ text: `❌ ${err.message}`, data: {} });
        });
    });
}

export async function orchestrateAndCollect(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<string> {
    return (await orchestrateAndCollectData(prompt, meta, locale)).text;
}
