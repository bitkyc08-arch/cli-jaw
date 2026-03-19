type MatcherMap = Record<string, RegExp[]>;

const GENERIC_STALE_MATCHERS = [
    /no conversation found with session id/i,
    /\bconversation\b.*\bnot found\b/i,
    /\bsession\b.*\bnot found\b/i,
    /\binvalid\b.*\bresume\b/i,
    /\bresume\b.*\binvalid\b/i,
    /\bunknown\b.*\bsession\b/i,
    /\bno such session\b/i,
];

const CLI_STALE_MATCHERS: MatcherMap = {
    claude: [
        /no conversation found with session id/i,
    ],
    codex: [
        /\bconversation\b.*\bnot found\b/i,
        /\bresume\b.*\bnot found\b/i,
    ],
    gemini: [
        /\bsession\b.*\bnot found\b/i,
        /\bresume\b.*\bnot found\b/i,
    ],
    opencode: [
        /\bsession\b.*\bnot found\b/i,
    ],
    copilot: [
        /\bsession\b.*\bnot found\b/i,
        /\bloadsession\b.*\bfailed\b/i,
    ],
};

export function shouldInvalidateResumeSession(
    cli: string,
    code: number | null | undefined,
    stderr = '',
    resultText = '',
): boolean {
    if (code === 0) return false;
    const haystack = `${stderr}\n${resultText}`.trim();
    if (!haystack) return false;

    const matchers = [
        ...(CLI_STALE_MATCHERS[cli] || []),
        ...GENERIC_STALE_MATCHERS,
    ];
    return matchers.some((pattern) => pattern.test(haystack));
}
