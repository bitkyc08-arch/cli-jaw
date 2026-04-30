import { buildContextPackageResult, prepareContextForBrowser } from './builder.js';
import type { ContextPackInput, ContextPackResult } from './types.js';

export async function contextDryRun(input: ContextPackInput = {}): Promise<ContextPackResult> {
    const result = input.contextTransport === 'inline' || input.inlineOnly === true
        ? await buildContextPackageResult(input)
        : await prepareContextForBrowser(input);
    if (!result) throw new Error('context files required. Pass --context-from-files or --context-file.');
    return { ...result, status: 'dry-run' };
}

export async function contextRender(input: ContextPackInput = {}): Promise<ContextPackResult> {
    const result = input.contextTransport === 'inline' || input.inlineOnly === true
        ? await buildContextPackageResult(input)
        : await prepareContextForBrowser(input);
    if (!result) throw new Error('context files required. Pass --context-from-files or --context-file.');
    return { ...result, status: 'rendered' };
}
