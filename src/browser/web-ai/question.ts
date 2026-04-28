import type { QuestionEnvelope, QuestionEnvelopeInput, RenderedQuestionBundle, WebAiVendor } from './types.js';

const INLINE_CHAR_LIMIT = 50000;
const SUPPORTED_VENDOR: WebAiVendor = 'chatgpt';

export function normalizeEnvelope(input: QuestionEnvelopeInput = {}): QuestionEnvelope {
    const vendor = input.vendor || SUPPORTED_VENDOR;
    if (vendor !== SUPPORTED_VENDOR) {
        throw new Error(`unsupported vendor: ${vendor}. PRD32 first slice supports chatgpt only.`);
    }

    const prompt = cleanOptional(input.prompt || input.question);
    if (!prompt) throw new Error('prompt required');

    const attachmentPolicy = input.attachmentPolicy || 'inline-only';
    if (attachmentPolicy !== 'inline-only') {
        throw new Error('file upload is future scope. Use --inline-only.');
    }

    return {
        vendor: SUPPORTED_VENDOR,
        prompt,
        attachmentPolicy: 'inline-only',
        ...(cleanOptional(input.system) ? { system: cleanOptional(input.system) } : {}),
        ...(cleanOptional(input.project) ? { project: cleanOptional(input.project) } : {}),
        ...(cleanOptional(input.goal) ? { goal: cleanOptional(input.goal) } : {}),
        ...(cleanOptional(input.context) ? { context: cleanOptional(input.context) } : {}),
        ...(cleanOptional(input.question) ? { question: cleanOptional(input.question) } : {}),
        ...(cleanOptional(input.output) ? { output: cleanOptional(input.output) } : {}),
        ...(cleanOptional(input.constraints) ? { constraints: cleanOptional(input.constraints) } : {}),
    };
}

export function renderQuestionEnvelope(input: QuestionEnvelopeInput = {}): RenderedQuestionBundle {
    const envelope = normalizeEnvelope(input);
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
