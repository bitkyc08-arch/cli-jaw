// ─── Agent CLI Argument Builders ──────────────────────
// Extracted from agent.js for 500-line compliance.

export function buildArgs(cli, model, effort, prompt, sysPrompt, permissions = 'auto') {
    const autoPerm = permissions === 'auto';
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : []),
                ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : [])];
        case 'codex':
            return ['exec',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check', '--json'];
        case 'gemini':
            return ['-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        case 'opencode':
            return ['run',
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}

export function buildResumeArgs(cli, model, effort, sessionId, prompt, permissions = 'auto') {
    const autoPerm = permissions === 'auto';
    switch (cli) {
        case 'claude':
            return ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages',
                ...(autoPerm ? ['--dangerously-skip-permissions'] : []),
                '--resume', sessionId,
                '--max-turns', '50',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(effort && effort !== 'medium' ? ['--effort', effort] : [])];
        case 'codex':
            return ['exec', 'resume',
                ...(model && model !== 'default' ? ['--model', model] : []),
                ...(autoPerm ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                '--skip-git-repo-check',
                sessionId, prompt || '', '--json'];
        case 'gemini':
            return ['--resume', sessionId,
                '-p', prompt || '',
                ...(model && model !== 'default' ? ['-m', model] : []),
                '-y', '-o', 'stream-json'];
        case 'opencode':
            return ['run', '-s', sessionId,
                ...(model && model !== 'default' ? ['-m', model] : []),
                ...(effort ? ['--variant', effort] : []),
                '--format', 'json',
                prompt || ''];
        default:
            return [];
    }
}
