import crypto from 'node:crypto';
import type { SpawnContext } from '../types/agent.js';

export const AGY_BOOTSTRAP_VERSION = 1;
export const AGY_BOOTSTRAP_PREFIX = 'CLI_JAW_BOOTSTRAP_SHA=';

export type AgyBootstrapEnvelope = {
    sentinel: string;
    hash: string;
    prompt: string;
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

export function buildAgyBootstrapEnvelope(input: {
    taskPrompt: string;
    operationalContext?: string;
    historyBlock?: string;
    workingDir?: string | null;
    sessionId?: string | null;
    timestampMs?: number;
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
    const sections = [
        [
            '[CLI-JAW AGY BOOTSTRAP]',
            sentinel,
            `cwd=${workingDir}`,
            `session=${sessionId}`,
            'rule=This marker proves the current cli-jaw runtime envelope reached AGY.',
        ].join('\n'),
        `[Current cli-jaw task]\n${taskPrompt}`,
    ];

    if (operationalContext) {
        sections.push([
            '[Operational Context — cli-jaw Integration]',
            'The following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:',
            '',
            operationalContext,
        ].join('\n'));
    }
    if (historyBlock) {
        sections.push(`[Recent context / history]\n${historyBlock}`);
    }

    return {
        sentinel,
        hash,
        prompt: sections.join('\n\n---\n\n'),
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
