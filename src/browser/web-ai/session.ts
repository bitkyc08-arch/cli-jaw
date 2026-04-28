import { createHash } from 'node:crypto';
import type { CommittedTurnBaseline, QuestionEnvelope, WebAiVendor } from './types.js';

const baselines = new Map<string, CommittedTurnBaseline>();

export function hashPrompt(envelope: QuestionEnvelope): string {
    const payload = {
        vendor: envelope.vendor,
        system: envelope.system || '',
        prompt: envelope.prompt || '',
        project: envelope.project || '',
        goal: envelope.goal || '',
        context: envelope.context || '',
        question: envelope.question || '',
        output: envelope.output || '',
        constraints: envelope.constraints || '',
        attachmentPolicy: envelope.attachmentPolicy,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function makeBaselineKey(vendor: WebAiVendor, targetId: string): string {
    return `${vendor}:${targetId || 'unverified-target'}`;
}

export function saveBaseline(input: {
    vendor: WebAiVendor;
    targetId: string;
    url: string;
    envelope: QuestionEnvelope;
    assistantCount: number;
    textHash?: string;
}): CommittedTurnBaseline {
    const baseline: CommittedTurnBaseline = {
        vendor: input.vendor,
        targetId: input.targetId,
        url: input.url,
        promptHash: hashPrompt(input.envelope),
        assistantCount: input.assistantCount,
        capturedAt: new Date().toISOString(),
        ...(input.textHash ? { textHash: input.textHash } : {}),
    };
    baselines.set(makeBaselineKey(input.vendor, input.targetId), baseline);
    return baseline;
}

export function getBaseline(vendor: WebAiVendor, targetId: string): CommittedTurnBaseline | null {
    return baselines.get(makeBaselineKey(vendor, targetId)) || null;
}

export function clearBaseline(vendor: WebAiVendor, targetId: string): void {
    baselines.delete(makeBaselineKey(vendor, targetId));
}
