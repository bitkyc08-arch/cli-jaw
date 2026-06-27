import crypto from 'node:crypto';
import type { SpawnContext } from '../types/agent.js';

export const AGY_BOOTSTRAP_VERSION = 1;
export const AGY_BOOTSTRAP_PREFIX = 'CLI_JAW_BOOTSTRAP_SHA=';

export type AgyPromptSegmentId =
    | 'bootstrap'
    | 'current-task'
    | 'operational-context'
    | 'history';

export type AgyPromptSpillReport = {
    included: AgyPromptSegmentId[];
    truncated: AgyPromptSegmentId[];
    omitted: AgyPromptSegmentId[];
    totalChars: number;
    bootstrapHash: string;
};

export type AgyBootstrapEnvelope = {
    sentinel: string;
    hash: string;
    prompt: string;
    spill: AgyPromptSpillReport;
};

function normalizeText(value: string | null | undefined): string {
    return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeScalar(value: string | null | undefined, fallback: string): string {
    const normalized = normalizeText(value);
    return normalized || fallback;
}

function shortSha256(value: unknown): string {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex')
        .slice(0, 16);
}

function trimSegmentToBudget(text: string, budget: number): { text: string; truncated: boolean; omitted: boolean } {
    if (budget <= 0) return { text: '', truncated: false, omitted: true };
    if (text.length <= budget) return { text, truncated: false, omitted: false };
    const marker = '\n[... truncated by cli-jaw AGY prompt budget ...]';
    if (budget <= marker.length + 16) return { text: '', truncated: false, omitted: true };
    return {
        text: text.slice(0, budget - marker.length).trimEnd() + marker,
        truncated: true,
        omitted: false,
    };
}

function buildSpillReport(input: {
    segments: Array<{ id: AgyPromptSegmentId; text: string }>;
    prompt: string;
    hash: string;
    truncated: AgyPromptSegmentId[];
    omitted: AgyPromptSegmentId[];
}): AgyPromptSpillReport {
    const present = input.segments
        .filter((segment) => segment.text.trim())
        .map((segment) => segment.id);
    return {
        included: present.filter((id) => !input.omitted.includes(id)),
        truncated: input.truncated,
        omitted: input.omitted,
        totalChars: input.prompt.length,
        bootstrapHash: input.hash,
    };
}

export function buildAgyBootstrapEnvelope(input: {
    taskPrompt: string;
    operationalContext?: string;
    historyBlock?: string;
    workingDir?: string | null;
    sessionId?: string | null;
    timestampMs?: number;
    maxChars?: number;
}): AgyBootstrapEnvelope {
    const taskPrompt = normalizeText(input.taskPrompt);
    const operationalContext = normalizeText(input.operationalContext);
    const historyBlock = normalizeText(input.historyBlock);
    const workingDir = normalizeScalar(input.workingDir, 'unknown');
    const sessionId = normalizeScalar(input.sessionId, 'fresh');
    const hash = shortSha256({
        version: AGY_BOOTSTRAP_VERSION,
        taskPrompt,
        operationalContext,
        workingDir,
        sessionId,
    });
    const sentinel = `${AGY_BOOTSTRAP_PREFIX}${hash}`;
    const bootstrap = [
        '[CLI-JAW AGY BOOTSTRAP]',
        sentinel,
        `cwd=${workingDir}`,
        `session=${sessionId}`,
        'rule=This marker proves the current cli-jaw runtime envelope reached AGY.',
    ].join('\n');
    const currentTask = `[Current cli-jaw task]\n${taskPrompt}`;
    const operationalSection = operationalContext
        ? [
            '[Operational Context — cli-jaw Integration]',
            'The following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:',
            '',
            operationalContext,
        ].join('\n')
        : '';
    const historySection = historyBlock ? `[Recent context / history]\n${historyBlock}` : '';
    const requiredSegments = [
        { id: 'bootstrap' as const, text: bootstrap },
        { id: 'current-task' as const, text: currentTask },
    ];
    let optionalSegments = [
        { id: 'operational-context' as const, text: operationalSection },
        { id: 'history' as const, text: historySection },
    ].filter((segment) => segment.text);
    const originalSegments = [
        ...requiredSegments,
        { id: 'operational-context' as const, text: operationalSection },
        { id: 'history' as const, text: historySection },
    ];
    const truncated: AgyPromptSegmentId[] = [];
    const omitted: AgyPromptSegmentId[] = [];
    const joinPrompt = () => [...requiredSegments, ...optionalSegments]
        .filter((segment) => segment.text)
        .map((segment) => segment.text)
        .join('\n\n---\n\n');
    let prompt = joinPrompt();

    if (typeof input.maxChars === 'number' && Number.isFinite(input.maxChars) && input.maxChars > 0 && prompt.length > input.maxChars) {
        for (const id of ['history', 'operational-context'] as const) {
            prompt = joinPrompt();
            if (prompt.length <= input.maxChars) break;
            const idx = optionalSegments.findIndex((segment) => segment.id === id);
            if (idx < 0) continue;
            const targetSegment = optionalSegments[idx];
            if (!targetSegment) continue;
            const withoutSegment = optionalSegments.filter((_, segmentIdx) => segmentIdx !== idx);
            const promptWithoutSegment = [...requiredSegments, ...withoutSegment]
                .filter((segment) => segment.text)
                .map((segment) => segment.text)
                .join('\n\n---\n\n');
            const separatorCost = promptWithoutSegment ? '\n\n---\n\n'.length : 0;
            const budget = input.maxChars - promptWithoutSegment.length - separatorCost;
            const trimmed = trimSegmentToBudget(targetSegment.text, budget);
            if (trimmed.omitted) {
                omitted.push(id);
                optionalSegments = withoutSegment;
            } else {
                if (trimmed.truncated) truncated.push(id);
                optionalSegments[idx] = { id, text: trimmed.text };
            }
        }
        prompt = joinPrompt();
    }

    return {
        sentinel,
        hash,
        prompt,
        spill: buildSpillReport({
            segments: originalSegments,
            prompt,
            hash,
            truncated,
            omitted,
        }),
    };
}

export function transcriptContainsBootstrapSentinel(line: string, sentinel: string): boolean {
    if (!sentinel) return false;
    if (line.includes(sentinel)) return true;
    try {
        const parsed = JSON.parse(line) as { content?: unknown };
        return typeof parsed.content === 'string' && parsed.content.includes(sentinel);
    } catch {
        return false;
    }
}

export function applyAgyBootstrapAcceptanceFromTranscriptLine(
    ctx: Pick<SpawnContext,
        'agyBootstrapSentinel' |
        'agyBootstrapAccepted' |
        'agyBootstrapAcceptanceMode'
    >,
    line: string,
    minCreatedAtMs: number,
): void {
    const sentinel = ctx.agyBootstrapSentinel;
    if (!sentinel) {
        ctx.agyBootstrapAccepted = false;
        ctx.agyBootstrapAcceptanceMode = 'not-applicable';
        return;
    }

    let rowType = '';
    try {
        const parsed = JSON.parse(line) as { created_at?: unknown; type?: unknown };
        rowType = typeof parsed.type === 'string' ? parsed.type : '';
        if (typeof parsed.created_at === 'string') {
            const createdAt = Date.parse(parsed.created_at);
            if (Number.isFinite(createdAt) && createdAt < minCreatedAtMs) return;
        }
    } catch {
        return;
    }
    if (rowType !== 'USER_INPUT') return;

    if (transcriptContainsBootstrapSentinel(line, sentinel)) {
        ctx.agyBootstrapAccepted = true;
        ctx.agyBootstrapAcceptanceMode = 'accepted';
        return;
    }
    if (ctx.agyBootstrapAcceptanceMode !== 'accepted') {
        ctx.agyBootstrapAccepted = false;
        ctx.agyBootstrapAcceptanceMode = 'missing';
    }
}
