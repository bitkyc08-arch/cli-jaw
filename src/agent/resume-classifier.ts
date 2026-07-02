import { isKiroStaleSessionOutput } from './kiro-runtime.js';

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
    'claude-e': [
        /prompt injection did not reach Claude transcript/i,
        /prompt injection transcript verification failed/i,
        /prompt injection cannot be verified/i,
    ],
    codex: [
        /\bconversation\b.*\bnot found\b/i,
        /\bresume\b.*\bnot found\b/i,
        /\bno rollout found\b/i,              // codex: thread/resume failed when rollout missing / cross-bucket
        /\bthread\/resume failed\b/i,
    ],
    grok: [
        /\bsession\b.*\bnot found\b/i,
        /\bresume\b.*\bnot found\b/i,
        /\bsession\b.*\bdoes not exist\b/i,
        /couldn.*t create session/i,
    ],
    opencode: [
        /\bsession\b.*\bnot found\b/i,
    ],
    copilot: [
        /\bsession\b.*\bnot found\b/i,
        /\bloadsession\b.*\bfailed\b/i,
    ],
    'kiro-code': [
        /\bno saved chat sessions\b/i,
        /\bconversation\b.*\bnot found\b/i,
        /\bsession\b.*\bnot found\b/i,
        /\binvalid\b.*\bresume\b/i,
    ],
    kiro: [
        /\bno saved chat sessions\b/i,
        /\bconversation\b.*\bnot found\b/i,
        /\bsession\b.*\bnot found\b/i,
        /\binvalid\b.*\bresume\b/i,
    ],
};

export function shouldInvalidateResumeSession(
    cli: string,
    code: number | null | undefined,
    stderr = '',
    resultText = '',
): boolean {
    if (code === 0) {
        if (cli === 'kiro-code' || cli === 'kiro') {
            return isKiroStaleSessionOutput(`${stderr}\n${resultText}`);
        }
        return false;
    }
    const haystack = `${stderr}\n${resultText}`.trim();
    if (!haystack) return false;

    const matchers = [
        ...(CLI_STALE_MATCHERS[cli] || []),
        ...GENERIC_STALE_MATCHERS,
    ];
    return matchers.some((pattern) => pattern.test(haystack));
}
