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
