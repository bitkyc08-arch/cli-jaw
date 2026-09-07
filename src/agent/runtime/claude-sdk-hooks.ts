import type { HookCallback, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';

function deny(reason: string): HookJSONOutput {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    };
}

const foregroundOnly: HookCallback = async (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (signal.aborted) return deny('Native runtime tool request was aborted.');

    const args = input.tool_input;
    const background = args !== null && typeof args === 'object' && !Array.isArray(args)
        && 'run_in_background' in args ? args.run_in_background : undefined;

    // SDK 0.3.261 defaults Agent to background when this option is omitted.
    if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && background !== false) {
        return deny('Native runtime supports foreground Agent/Task only; set run_in_background:false.');
    }
    if (input.tool_name === 'Bash' && background === true) {
        return deny('Native runtime supports foreground Bash only; set run_in_background:false.');
    }
    // Neutral output preserves the existing permission engine and original arguments.
    return {};
};

/** Restrict SDK background options; this is not an OS or shell sandbox. */
export function claudeForegroundHooks(): NonNullable<Options['hooks']> {
    return { PreToolUse: [{ matcher: '^(Agent|Task|Bash)$', hooks: [foregroundOnly] }] };
}
