/**
 * Decide whether a failed Windows launch resolution may fall back to `shell: true` (#367).
 *
 * Stage 1 removed the shell wherever `resolveWindowsLaunchSpec` could resolve a target.
 * What it left behind was an unconditional fallback: when resolution failed, the spawn
 * site still handed the command to cmd.exe. That is fine for argv made of flags and
 * identifiers, and it is exactly the vulnerability for argv carrying a user prompt —
 * cmd.exe re-parses `& | < > ^ ( ) % !` in that text, so a prompt can start a second
 * command.
 *
 * Stage 2 makes the fallback conditional on what the argv actually contains rather than
 * on which runtime is spawning. That ordering matters: a per-CLI allowlist silently
 * fails open the moment a new runtime is added or an existing one starts passing the
 * prompt positionally, whereas inspecting the values themselves cannot go stale.
 *
 * The rule:
 *   - argv carries untrusted text and resolution failed -> REFUSE (no shell, no launch)
 *   - argv carries no untrusted text                    -> legacy shell fallback allowed
 *
 * Refusing is safe to do now precisely because it is narrow. It only fires when all
 * three conditions hold at once: Windows, a command we could not resolve, and a prompt
 * in argv. Runtimes that already carry the prompt on stdin are untouched, so this does
 * not break working installs to close a hole they never had.
 */

/** Characters cmd.exe treats as syntax rather than data. */
const CMD_METACHARACTERS = /[&|<>^()%!"]/;

/**
 * The subset that lets one command become two: chaining, piping, redirection, escape,
 * and variable expansion.
 *
 * Parentheses and double quotes are deliberately EXCLUDED here even though cmd.exe
 * treats them as syntax. They occur in ordinary Windows paths — `C:\Program Files (x86)`
 * is the obvious one — so refusing on them would break normal installs on a compatibility
 * path whose whole purpose is to keep unusual installs working. They stay in
 * CMD_METACHARACTERS, which only explains a refusal rather than causing one.
 */
const CMD_COMMAND_SEPARATORS = /[&|<>^%!]/;

export type ShellFallbackDecision =
    | { allowed: true }
    | { allowed: false; reason: string };

/**
 * Does this argv contain the untrusted text we refuse to route through cmd.exe?
 *
 * Membership is decided by VALUE, not by position or flag name. The prompt and system
 * prompt are the untrusted inputs; if either appears as an argv element, that element is
 * attacker-influenced regardless of which flag precedes it.
 *
 * Two matching modes, because one alone is wrong in a different direction:
 *
 *  - EXACT: an argv element that IS the candidate is untrusted at any length. Review
 *    found the earlier length-only rule fail-open — `prompt = "&a"` passed straight
 *    through to cmd.exe carrying shell syntax. Length is a property of what the user
 *    happened to type, so a boundary that depends on it is not a boundary.
 *  - SUBSTRING: only for candidates long enough to be distinctive, since runtimes that
 *    concatenate (`--message=<prompt>`) never produce an exact element. Applying
 *    substring matching to a 2-character value would match "gp" inside `--model gpt-5`
 *    and refuse launches that carry no prompt at all.
 */
const SUBSTRING_MATCH_MIN_LENGTH = 8;

export function argvCarriesUntrustedText(argv: readonly string[], untrusted: readonly (string | undefined)[]): boolean {
    const candidates = untrusted
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0);
    if (!candidates.length) return false;
    return argv.some(arg => candidates.some(candidate =>
        arg === candidate
        || (candidate.length >= SUBSTRING_MATCH_MIN_LENGTH && arg.includes(candidate)),
    ));
}

/**
 * Would cmd.exe reinterpret any of this argv as syntax?
 *
 * Used to explain a refusal, not to authorise one. A prompt with no metacharacters is
 * still refused: whether today's specific prompt happens to be inert is a property of
 * the input, not of the code path, and a guard that depends on the input is not a guard.
 */
export function argvHasCmdMetacharacters(argv: readonly string[]): boolean {
    return argv.some(arg => CMD_METACHARACTERS.test(arg));
}

/**
 * The stage-2 gate. Call at a Windows spawn site when resolution returned null and the
 * legacy `shell: true` path is the only remaining option.
 */
export function decideShellFallback(input: {
    argv: readonly string[];
    prompt?: string;
    sysPrompt?: string;
    command: string;
}): ShellFallbackDecision {
    const carriesUntrusted = argvCarriesUntrustedText(input.argv, [input.prompt, input.sysPrompt]);
    // Second, independent condition. Value matching proves that THIS prompt is in argv;
    // it cannot prove that nothing else attacker-influenced is. Review found exactly that
    // gap on other runtimes, where a model name, API key, or session id flows into argv
    // and is only trimmed. Anything that could split one command into two is refused on
    // this path regardless of where it came from.
    const carriesSeparators = input.argv.some(arg => CMD_COMMAND_SEPARATORS.test(arg));
    if (!carriesUntrusted && !carriesSeparators) {
        return { allowed: true };
    }
    const metachars = argvHasCmdMetacharacters(input.argv);
    const cause = carriesUntrusted
        ? 'the prompt is passed in argv'
        : 'the argv contains characters cmd.exe would read as command syntax';
    return {
        allowed: false,
        reason:
            `Refusing to launch "${input.command}" through cmd.exe: ${cause} and ` +
            `this command could not be resolved to a shell-free launch target` +
            (carriesUntrusted && metachars ? ', and the argv contains cmd.exe metacharacters' : '') +
            '. Routing prompt text through a shell lets it be reparsed as commands (#367). ' +
            'Reinstall the CLI so its shim resolves, or use a runtime that passes the prompt on stdin.',
    };
}
