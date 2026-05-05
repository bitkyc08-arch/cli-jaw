import { stripUndefined } from '../../core/strip-undefined.js';

const CAPTURE_METHODS = new Set(['copy-button', 'dom-fallback', 'clipboard', 'manual', 'unknown']);

export interface AnswerArtifact {
    provider: string;
    sessionId: string | null;
    conversationUrl: string | null;
    capturedBy: string;
    markdown: string;
    text: string;
    exactnessScore: number;
    responseStableMs: number | null;
    warnings: string[];
}

export interface AnswerArtifactInput {
    provider?: string;
    sessionId?: string | null;
    conversationUrl?: string | null;
    capturedBy?: string;
    captureMethod?: string;
    markdown?: string;
    text?: string;
    exactnessScore?: number;
    responseStableMs?: number | string | null;
    warnings?: unknown[];
}

export function createAnswerArtifact(input: AnswerArtifactInput = {}): AnswerArtifact {
    const capturedBy = normalizeCaptureMethod(input.capturedBy || input.captureMethod);
    const markdown = normalizeText(input.markdown);
    const text = normalizeText(input.text || markdown);
    const warnings = Array.isArray(input.warnings) ? input.warnings.filter(Boolean).map(String) : [];
    const exactnessScore = input.exactnessScore === undefined
        ? estimateExactnessScore({ capturedBy, markdown, text })
        : clampScore(Number(input.exactnessScore));

    return {
        provider: input.provider || 'unknown',
        sessionId: input.sessionId || null,
        conversationUrl: input.conversationUrl || null,
        capturedBy,
        markdown,
        text,
        exactnessScore,
        responseStableMs: Number.isFinite(Number(input.responseStableMs)) ? Number(input.responseStableMs) : null,
        warnings,
    };
}

export function artifactFromPollResult(result: object = {}, context: object = {}): AnswerArtifact {
    const resultUsedFallbacks = readProp(result, 'usedFallbacks');
    const capturedBy = stringValue(readProp(result, 'capturedBy'))
        || stringValue(readProp(result, 'captureMethod'))
        || (Array.isArray(resultUsedFallbacks) && resultUsedFallbacks.includes('copy-markdown') ? 'copy-button' : null)
        || (readProp(result, 'answerText') ? 'dom-fallback' : 'unknown');
    const contextWarnings = readProp(context, 'warnings');
    const resultWarnings = readProp(result, 'warnings');

    return createAnswerArtifact(stripUndefined({
        provider: stringValue(readProp(result, 'vendor')) || stringValue(readProp(context, 'provider')),
        sessionId: stringValue(readProp(result, 'sessionId')) || stringValue(readProp(context, 'sessionId')),
        conversationUrl: stringValue(readProp(result, 'conversationUrl')) || stringValue(readProp(result, 'url')) || stringValue(readProp(context, 'conversationUrl')),
        capturedBy,
        markdown: stringValue(readProp(result, 'markdown')) || stringValue(readProp(result, 'answerMarkdown')) || stringValue(readProp(result, 'answerText')),
        text: stringValue(readProp(result, 'text')) || stringValue(readProp(result, 'answerText')) || stringValue(readProp(result, 'markdown')) || stringValue(readProp(result, 'answerMarkdown')),
        responseStableMs: readProp(result, 'responseStableMs') as number | string | null | undefined,
        warnings: [...arrayValue(contextWarnings), ...arrayValue(resultWarnings)],
    }));
}

export function withAnswerArtifact<T extends object>(result: T, context: object = {}): T & { answerArtifact?: AnswerArtifact } {
    const output = result as T & { answerArtifact?: AnswerArtifact; answerText?: unknown; markdown?: unknown; answerMarkdown?: unknown; text?: unknown };
    if (output.answerArtifact) return output;
    if (!output.answerText && !output.markdown && !output.answerMarkdown && !output.text) return output;
    return {
        ...result,
        answerArtifact: artifactFromPollResult(result, context),
    };
}

export function summarizeAnswerArtifact(artifact: AnswerArtifactInput = {}): Record<string, unknown> {
    const normalized = createAnswerArtifact(artifact);
    return {
        provider: normalized.provider,
        sessionId: normalized.sessionId,
        capturedBy: normalized.capturedBy,
        markdownChars: normalized.markdown.length,
        textChars: normalized.text.length,
        exactnessScore: normalized.exactnessScore,
        warningCount: normalized.warnings.length,
    };
}

function normalizeCaptureMethod(value: unknown): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return CAPTURE_METHODS.has(normalized) ? normalized : 'unknown';
}

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function readProp(source: object, key: string): unknown {
    return (source as Record<string, unknown>)[key];
}

function estimateExactnessScore(input: { capturedBy: string; markdown: string; text: string }): number {
    if (!input.markdown && !input.text) return 0;
    if (input.capturedBy === 'copy-button' || input.capturedBy === 'clipboard') return 1;
    if (input.capturedBy === 'dom-fallback') return 0.75;
    if (input.markdown && input.text && input.markdown.trim() === input.text.trim()) return 0.8;
    return 0.5;
}

function clampScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}
