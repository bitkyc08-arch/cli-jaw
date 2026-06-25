/**
 * 104.8 — Grok runtime capability-probe array (port of agbrowse `grok-live.mjs:grokCapabilities`).
 *
 * Own module (not grok-live.ts) for the same size/cycle reasons as gemini-capabilities.ts.
 * Probes are READ-ONLY (see capability-probe.ts).
 */

import {
    defineCapability,
    probeFirstVisibleSelector,
    probeHostMatches,
    runCapabilities,
    worstCapabilityState,
    type CapabilityDeps,
    type CapabilityInput,
} from './capability-probe.js';
import { grokModelCapabilityProbe } from './grok-model.js';
import { GROK_COMPOSER_SELECTORS, GROK_STREAMING_SELECTORS, GROK_UPLOAD_SELECTORS } from './vendor-editor-contract.js';
import { GROK_COPY_SELECTORS } from './copy-markdown.js';
import type { VendorCapabilityStatus } from './gemini-capabilities.js';

const GROK_HOSTS = new Set(['grok.com']);

export const grokCapabilities = [
    defineCapability('grok-active-tab-verification', async (deps) => probeHostMatches(await deps.getPage(), GROK_HOSTS)),
    defineCapability('grok-composer-visible', async (deps) => probeFirstVisibleSelector(await deps.getPage(), GROK_COMPOSER_SELECTORS)),
    defineCapability('grok-model-alias-selectable', async (deps, input) => grokModelCapabilityProbe(await deps.getPage(), typeof input['model'] === 'string' ? input['model'] : undefined)),
    defineCapability('grok-upload-surface-visible', async (deps, input) => {
        if (!input['filePath'] && input['inlineOnly'] !== false) return { state: 'unknown', evidence: { required: false }, next: 'send' };
        return probeFirstVisibleSelector(await deps.getPage(), GROK_UPLOAD_SELECTORS, { failNext: 'inline-only' });
    }),
    defineCapability('grok-copy-button-present', async (deps, input) => {
        if (!input['allowCopyMarkdownFallback']) return { state: 'unknown', evidence: { required: false }, next: 'send' };
        return probeFirstVisibleSelector(await deps.getPage(), GROK_COPY_SELECTORS.copyButtonSelectors, { timeoutMs: 500, failNext: 'send', failState: 'warn' });
    }),
    defineCapability('grok-response-streaming', async (deps) => {
        const page = await deps.getPage();
        for (const sel of GROK_STREAMING_SELECTORS) {
            // eslint-disable-next-line no-await-in-loop -- a visible Stop button means we're still streaming.
            if (await page.locator(sel).first().isVisible().catch(() => false)) {
                return { state: 'warn', evidence: { streaming: true, selector: sel }, next: 'poll' };
            }
        }
        return { state: 'ok', evidence: { streaming: false }, next: 'send' };
    }),
];

export async function grokCapabilityStatus(deps: CapabilityDeps, input: CapabilityInput = {}): Promise<VendorCapabilityStatus> {
    const capabilities = await runCapabilities(deps, grokCapabilities, input);
    return { capabilities, capabilityState: worstCapabilityState(capabilities) };
}
