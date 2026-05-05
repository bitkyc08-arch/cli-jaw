import type { AttachmentPolicy, QuestionEnvelope, QuestionEnvelopeInput, RenderedQuestionBundle, WebAiVendor } from './types.js';

const INLINE_CHAR_LIMIT = 50000;
const SUPPORTED_VENDORS = new Set<WebAiVendor>(['chatgpt', 'gemini', 'grok']);
const SUPPORTED_ATTACHMENT_POLICIES = new Set<AttachmentPolicy>(['inline-only', 'upload', 'auto']);

export function normalizeEnvelope(input: QuestionEnvelopeInput = {}): QuestionEnvelope {
    const vendor = (input.vendor || 'chatgpt') as WebAiVendor;
    if (!SUPPORTED_VENDORS.has(vendor)) {
        throw new Error(`unsupported vendor: ${vendor}`);
    }

    const prompt = cleanOptional(input.prompt || input.question);
    if (!prompt) throw new Error('prompt required');

    const attachmentPolicy = (input.attachmentPolicy || 'inline-only') as AttachmentPolicy;
    if (!SUPPORTED_ATTACHMENT_POLICIES.has(attachmentPolicy)) {
        throw new Error(`unsupported attachment policy: ${attachmentPolicy}`);
    }

    const system = cleanOptional(input.system);
    const project = cleanOptional(input.project);
    const goal = cleanOptional(input.goal);
    const context = cleanOptional(input.context);
    const question = cleanOptional(input.question);
    const output = cleanOptional(input.output);
    const constraints = cleanOptional(input.constraints);
    return {
        vendor,
        prompt,
        attachmentPolicy,
        ...(system ? { system } : {}),
        ...(project ? { project } : {}),
        ...(goal ? { goal } : {}),
        ...(context ? { context } : {}),
        ...(question ? { question } : {}),
        ...(output ? { output } : {}),
        ...(constraints ? { constraints } : {}),
    };
}

export function renderQuestionEnvelope(input: QuestionEnvelopeInput = {}): RenderedQuestionBundle {
    const envelope = normalizeEnvelope(input);
    return renderNormalizedEnvelope(envelope);
}

export function renderQuestionEnvelopeWithContext(
    input: QuestionEnvelopeInput = {},
    contextComposerText = '',
): RenderedQuestionBundle {
    const envelope = normalizeEnvelope(input);
    const contextText = String(contextComposerText || '').trim();
    if (!contextText) return renderNormalizedEnvelope(envelope);
    return renderNormalizedEnvelope({
        ...envelope,
        question: contextText,
    });
}

function renderNormalizedEnvelope(envelope: QuestionEnvelope): RenderedQuestionBundle {
    const blocks: string[] = [];
    const warnings: string[] = [];

    if (envelope.system) blocks.push(section('[SYSTEM]', envelope.system));
    blocks.push(section('[USER]', [
        field('Project', envelope.project),
        field('Goal', envelope.goal),
        field('Context', envelope.context),
        field('Question', envelope.question || envelope.prompt),
        field('Output', envelope.output),
        field('Constraints', envelope.constraints),
    ].filter(Boolean).join('\n\n')));

    if (!envelope.project) warnings.push('project omitted');
    if (!envelope.goal) warnings.push('goal omitted');
    if (!envelope.output) warnings.push('output preference omitted');

    const composerText = blocks.join('\n\n');
    if (composerText.length > INLINE_CHAR_LIMIT) {
        throw new Error(`inline prompt too large: ${composerText.length}/${INLINE_CHAR_LIMIT} chars`);
    }
    return { markdown: composerText, composerText, estimatedChars: composerText.length, warnings };
}

function cleanOptional(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
}

function section(title: string, body: string): string {
    return `${title}\n${body}`;
}

function field(label: string, value?: string): string {
    if (!value) return '';
    return `## ${label}\n${value}`;
}
