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

export function orchestrateAndCollect(
    prompt: string,
    meta: Record<string, any> = {},
    locale: string = 'ko',
): Promise<string> {
    return new Promise((resolve) => {
        let collected = '';
        let timeout: ReturnType<typeof setTimeout>;
        const IDLE_TIMEOUT = 1200000;

        function resetTimeout() {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                removeBroadcastListener(handler);
                resolve(collected || t('tg.timeout', {}, locale));
            }, IDLE_TIMEOUT);
        }

        const handler = (type: string, data: Record<string, any>) => {
            if (type === 'agent_chunk' || type === 'agent_tool' ||
                type === 'agent_status' || type === 'agent_retry' ||
                type === 'agent_done' || type === 'agent_fallback' ||
                type === 'round_start' || type === 'round_done') {
                resetTimeout();
            }
            // NOTE: agent_output removed — no broadcast emits this event (dead branch)
            if (type === 'agent_done' && data.error && data.text) {
                collected = collected || data.text;
            }
            if (type === 'orchestrate_done') {
                // Filter by requestId (strongest), then origin, then chatId
                if (meta?.requestId && data?.requestId && data.requestId !== meta.requestId) return;
                if (meta?.origin && data?.origin && data.origin !== meta.origin) return;
                if (!meta?.requestId && meta?.chatId && data?.chatId && data.chatId !== meta.chatId) return;
                clearTimeout(timeout);
                removeBroadcastListener(handler);
                resolve(data.text || collected || t('tg.noResponse', {}, locale));
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
            resolve(`❌ ${err.message}`);
        });
        resetTimeout();
    });
}
