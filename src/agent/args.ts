// ─── Agent CLI Argument Builders ──────────────────────
// Extracted from agent.js for 500-line compliance.

const isCodexSparkModel = (model: string) => !!model && /spark/i.test(model);

/**
 * Session storage bucket — codex Spark lives in its own bucket so cross-model
 * resumes don't send a spark session_id to a gpt-5.4 run (or vice versa), which
 * would trigger `thread/resume failed: no rollout found` on the server side.
 */
export function resolveSessionBucket(cli: string | null | undefined, model: string | null | undefined): string {
    if (cli === 'codex' && isCodexSparkModel(model || '')) return 'codex-spark';
    return cli || '';
}

export function buildArgs(cli: string, model: string, effort: string, prompt: string, sysPrompt: string, permissions = 'auto', options: { fastMode?: boolean } = {}) {
    const autoPerm = permissions === 'auto';
    const fullPerm = permissions === 'auto' || permissions === 'yolo';
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : [])];
        case 'codex': {
            const spark = isCodexSparkModel(model);
            const reasoningArgs = spark ? [] : [
                ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
                '-c', 'model_reasoning_summary="detailed"',
                '-c', 'hide_agent_reasoning=false',
            ];
            // Spark is text-only at 128k context (per OpenAI launch post).
            // Pin 128k max + 110k auto-compact threshold so long turns auto-compact before overflow.
            const sparkContextArgs = spark ? [
                '-c', 'model_context_window=128000',
                '-c', 'model_auto_compact_token_limit=110000',
            ] : [];
            return ['exec',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...reasoningArgs,
                ...sparkContextArgs,
                ...(options.fastMode ? ['-c', 'service_tier="fast"'] : []),
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check', '--json'];
        }
        case 'gemini':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        case 'opencode':
            return ['run',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                ...(fullPerm ? ['--dangerously-skip-permissions'] : []),
                '--thinking',
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}

export function buildResumeArgs(cli: string, model: string, effort: string, sessionId: string, prompt: string, permissions = 'auto', options: { fastMode?: boolean; sysPrompt?: string } = {}) {
    const autoPerm = permissions === 'auto';
    const fullPerm = permissions === 'auto' || permissions === 'yolo';
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--resume', sessionId,
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...(options.sysPrompt ? ['--append-system-prompt', options.sysPrompt] : [])];
        case 'codex': {
            const spark = isCodexSparkModel(model);
            return ['exec', 'resume',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(spark ? [] : ['-c', 'model_reasoning_summary="detailed"']),
                ...(spark ? [] : ['-c', 'hide_agent_reasoning=false']),
                ...(spark ? ['-c', 'model_context_window=128000'] : []),
                ...(spark ? ['-c', 'model_auto_compact_token_limit=110000'] : []),
                ...(options.fastMode ? ['-c', 'service_tier="fast"'] : []),
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check',
                sessionId, prompt || '', '--json'];
        }
        case 'gemini':
            return ['--resume', sessionId,
                '-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        case 'opencode':
            return ['run', '-s', sessionId,
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                ...(fullPerm ? ['--dangerously-skip-permissions'] : []),
                '--thinking',
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}
