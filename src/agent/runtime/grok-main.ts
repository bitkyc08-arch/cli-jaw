import { GrokReplacement } from './acp/grok-control.js';
import { grokUsage } from './acp/grok-events.js';
import type { AcpRuntimeSessionOptions } from './acp/runtime-session.js';

export const grokMainOptions: Pick<AcpRuntimeSessionOptions, 'createReplacement' | 'resultUsage'> = {
    createReplacement: io => new GrokReplacement(io),
    resultUsage: grokUsage,
};
