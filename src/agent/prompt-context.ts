// Pure prompt assembly helpers for argv/stdin runtimes.

export const HISTORY_BOUNDARY_INSTRUCTION = [
    '[History Boundary]',
    'Recent Context is read-only background. The Current Message below is the only task to execute now.',
    'Do not continue prior plans, audits, commands, questions, or goals unless the Current Message explicitly asks to resume or continue them.',
].join('\n');

export function withHistoryPrompt(prompt: string, historyBlock: string): string {
    const body = String(prompt || '');
    if (!historyBlock) return body;
    return `${historyBlock}\n\n${HISTORY_BOUNDARY_INSTRUCTION}\n\n---\n[Current Message]\n${body}`;
}

/** Max chars of interrupted-turn partial output reinjected into a follow-up run. */
export const STEER_SALVAGE_MAX_CHARS = 4000;

/**
 * Prepend the salvaged partial output of a steer-interrupted turn.
 *
 * Kill-path steer (explicit /steer, /queue steer) kills the running CLI and
 * starts a fresh run. The vendor session only holds COMPLETED items, so the
 * in-flight partial output would otherwise be invisible to the follow-up model
 * (history injection is skipped on successful native resume). This block makes
 * the interruption and the partial output explicit, in both directions of the
 * resume matrix. Identity of the prompt itself is unchanged when there is no
 * salvage, so non-steer spawns are byte-identical to before.
 */
export function withSteerContext(prompt: string, steerContext?: string | null): string {
    const body = String(prompt || '');
    let salvage = String(steerContext || '').trim();
    if (!salvage) return body;
    let truncated = false;
    if (salvage.length > STEER_SALVAGE_MAX_CHARS) {
        salvage = salvage.slice(-STEER_SALVAGE_MAX_CHARS);
        truncated = true;
    }
    return [
        '[Interrupted Turn Context — cli-jaw steer]',
        'The previous turn was interrupted by a new instruction from the user (steer).',
        'Its partial output before the interruption is below and is INCOMPLETE.',
        'Remember what it was doing, do not repeat completed work, and continue with the current message.',
        '[이전 턴이 사용자의 새 지시(steer)로 중단되었습니다. 아래는 중단 시점까지의 미완성 부분 출력입니다.',
        '완료된 작업을 반복하지 말고, 맥락을 기억한 채 현재 메시지를 이어서 수행하세요.]',
        '',
        '<partial_output>',
        `${truncated ? '... [truncated]\n' : ''}${salvage}`,
        '</partial_output>',
        '',
        '---',
        body,
    ].join('\n');
}

export function shouldBuildHistoryBlock(input: {
    skipHistory: boolean;
    isResume: boolean;
    cli: string;
    codexMultiplexMain: boolean;
}): boolean {
    return !input.skipHistory
        && (input.codexMultiplexMain || !input.isResume || input.cli === 'pi');
}

function isArgvPromptRuntime(cli: string, effectiveProvider?: string | null): boolean {
    return cli === 'cursor'
        || cli === 'kiro-code'
        || cli === 'grok'
        || cli === 'opencode'
        || (cli === 'ai-e' && effectiveProvider !== 'claude');
}

function isKiroRuntime(cli: string, effectiveProvider?: string | null): boolean {
    return cli === 'kiro-code' || (cli === 'ai-e' && effectiveProvider === 'kiro');
}

function withOperationalContext(prompt: string, sysPrompt: string): string {
    return `[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\n${sysPrompt}\n\n---\n\n${prompt}`;
}

export function buildPromptForArgs(input: {
    cli: string;
    effectiveProvider?: string | null;
    prompt: string;
    historyBlock: string;
    sysPrompt: string;
    isResume: boolean;
}): string {
    if (isKiroRuntime(input.cli, input.effectiveProvider) && input.isResume) {
        return input.prompt;
    }

    const basePrompt = isArgvPromptRuntime(input.cli, input.effectiveProvider)
        ? withHistoryPrompt(input.prompt, input.historyBlock)
        : input.prompt;

    if (isKiroRuntime(input.cli, input.effectiveProvider) && input.sysPrompt) {
        return withOperationalContext(basePrompt, input.sysPrompt);
    }

    return basePrompt;
}
