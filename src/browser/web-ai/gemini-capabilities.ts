/**
 * 104.8 — Gemini runtime capability-probe array (port of agbrowse `gemini-live.mjs:geminiCapabilities`).
 *
 * Lives in its own module (not gemini-live.ts) to keep that file under the size limit and to
 * avoid a gemini-live ↔ capabilities import cycle. Probes are READ-ONLY (see capability-probe.ts).
 */

import {
    defineCapability,
    probeFirstVisibleSelector,
    probeHostMatches,
    runCapabilities,
    worstCapabilityState,
    type CapabilityDeps,
    type CapabilityInput,
    type CapabilityRow,
    type CapabilityState,
} from './capability-probe.js';
import { geminiModelCapabilityProbe } from './gemini-model.js';
import { GEMINI_COMPOSER_SELECTORS, GEMINI_RESPONSE_SELECTORS, GEMINI_STREAMING_SELECTORS, GEMINI_UPLOAD_SELECTORS } from './vendor-editor-contract.js';
import { GEMINI_COPY_SELECTORS } from './copy-markdown.js';

// Kept local (small Set) to avoid importing from gemini-live.ts and creating a cycle.
const GEMINI_HOSTS = new Set(['gemini.google.com']);
const GEMINI_RESPONSE_SELECTOR = GEMINI_RESPONSE_SELECTORS[0] ?? 'model-response';

export const geminiCapabilities = [
    defineCapability('gemini-active-tab-verification', async (deps) => probeHostMatches(await deps.getPage(), GEMINI_HOSTS)),
    defineCapability('gemini-composer-visible', async (deps) => probeFirstVisibleSelector(await deps.getPage(), GEMINI_COMPOSER_SELECTORS)),
    defineCapability('gemini-model-alias-selectable', async (deps, input) => geminiModelCapabilityProbe(await deps.getPage(), typeof input['model'] === 'string' ? input['model'] : undefined)),
    defineCapability('gemini-upload-surface-visible', async (deps, input) => {
        if (!input['filePath'] && input['inlineOnly'] !== false) return { state: 'unknown', evidence: { required: false }, next: 'send' };
        return probeFirstVisibleSelector(await deps.getPage(), GEMINI_UPLOAD_SELECTORS, { failNext: 'inline-only' });
    }),
    defineCapability('gemini-copy-button-present', async (deps, input) => {
        if (!input['allowCopyMarkdownFallback']) return { state: 'unknown', evidence: { required: false }, next: 'send' };
        return probeFirstVisibleSelector(await deps.getPage(), GEMINI_COPY_SELECTORS.copyButtonSelectors, { timeoutMs: 500, failNext: 'send', failState: 'warn' });
    }),
    defineCapability('gemini-response-streaming', async (deps) => {
        const page = await deps.getPage();
        for (const sel of GEMINI_STREAMING_SELECTORS) {
            // eslint-disable-next-line no-await-in-loop -- first visible completion marker wins.
            if (await page.locator(sel).first().isVisible().catch(() => false)) {
                return { state: 'ok', evidence: { streaming: false, completionSelector: sel }, next: 'send' };
            }
        }
        const hasResponse = await page.locator(GEMINI_RESPONSE_SELECTOR).first().isVisible().catch(() => false);
        if (hasResponse) return { state: 'warn', evidence: { streaming: true }, next: 'poll' };
        return { state: 'ok', evidence: { streaming: false }, next: 'send' };
    }),
];

export interface VendorCapabilityStatus {
    capabilities: CapabilityRow[];
    capabilityState: CapabilityState;
}

export async function geminiCapabilityStatus(deps: CapabilityDeps, input: CapabilityInput = {}): Promise<VendorCapabilityStatus> {
    const capabilities = await runCapabilities(deps, geminiCapabilities, input);
    return { capabilities, capabilityState: worstCapabilityState(capabilities) };
}
