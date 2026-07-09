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

export interface CollectedOrchestrateResult {
    text: string;
    data: Record<string, any>;
}

/** Like orchestrateAndCollect, but resolves the full orchestrate_done payload
 *  (e.g. elicitationSpecs for telegram inline keyboards) alongside the text. */
export function orchestrateAndCollectData(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<CollectedOrchestrateResult> {
    return new Promise((resolve) => {
        let collected = '';
        let timeout: ReturnType<typeof setTimeout>;
        const IDLE_TIMEOUT = 1200000;

        function resetTimeout() {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                removeBroadcastListener(handler);
                resolve({ text: collected || t('tg.timeout', {}, locale), data: {} });
            }, IDLE_TIMEOUT);
        }

        const handler = (type: string, data: Record<string, any>) => {
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
            }
            if (type === 'orchestrate_done') {
                // Filter by requestId (strongest), then origin, then chatId
                if (meta?.["requestId"] && data?.["requestId"] && data["requestId"] !== meta["requestId"]) return;
                if (meta?.["origin"] && data?.["origin"] && data["origin"] !== meta["origin"]) return;
                if (!meta?.["requestId"] && meta?.["chatId"] && data?.["chatId"] && data["chatId"] !== meta["chatId"]) return;
                clearTimeout(timeout);
                removeBroadcastListener(handler);
                resolve({ text: data["text"] || collected || t('tg.noResponse', {}, locale), data });
            }
        };
        addBroadcastListener(handler);
        const run = isResetIntent(prompt)
            ? orchestrateReset(meta)
            : isContinueIntent(prompt)
                ? orchestrateContinue(meta)
                : orchestrate(prompt, meta);
        Promise.resolve(run).catch(err => {
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve({ text: `❌ ${err.message}`, data: {} });
        });
        resetTimeout();
    });
}

export async function orchestrateAndCollect(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<string> {
    return (await orchestrateAndCollectData(prompt, meta, locale)).text;
}
