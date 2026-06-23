// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import { navigateInUserSession } from './browser-session.js';

const DEFAULT_HUMAN_TIMEOUT_MS = 300_000; // 5 minutes

interface HumanLoopOptions {
    interactive?: boolean;
    browserSession?: string;
    browserSessionRaw?: string;
    browserDeps?: Record<string, unknown>;
    timeoutMs?: number;
    humanTimeoutMs?: number;
    selector?: string | null;
    allowPrivateNetwork?: boolean;
}

interface ChallengeInfoInput {
    type?: string | null;
    primary?: { profile?: { id?: string } } | null;
}

export async function humanResolve(url: string, options: HumanLoopOptions, challengeInfo: ChallengeInfoInput) {
    const rawSession = options.browserSessionRaw || options.browserSession;
    if (!options.interactive && rawSession !== 'interactive') {
        return {
            ok: false,
            verdict: challengeInfo.type || 'challenge',
            humanActionNeeded: true,
            actionMessage: formatNonInteractiveMessage(challengeInfo, url),
        };
    }

    const message = formatChallengeMessage(challengeInfo, url);
    await presentToUser(message);
    await waitForUserSignal(options.humanTimeoutMs || DEFAULT_HUMAN_TIMEOUT_MS);

    const result = await navigateInUserSession(url, options);
    return {
        ...result,
        source: 'human_resolved',
        safetyFlags: ['user_session_used', 'human_action_taken'],
    };
}

function formatChallengeMessage(challengeInfo: ChallengeInfoInput, url: string): string {
    switch (challengeInfo.type) {
        case 'challenge': {
            const waf = challengeInfo.primary?.profile?.id ?? 'unknown';
            return [
                `Challenge detected at ${url}`,
                `Type: ${waf}`,
                `Action: Open this URL in your browser and solve the challenge.`,
                `Press Enter when done.`,
            ].join('\n');
        }
        case 'auth_required':
            return [
                `Login required at ${url}`,
                `Action: Log in via your browser.`,
                `Press Enter when done.`,
            ].join('\n');
        case 'paywall':
            return [
                `Paywall detected at ${url}`,
                `Action: If you have a subscription, ensure you're logged in.`,
                `Press Enter to read with your session, or Ctrl+C to skip.`,
            ].join('\n');
        default:
            return `Obstacle at ${url}. Open in your browser, resolve it, then press Enter.`;
    }
}

function formatNonInteractiveMessage(challengeInfo: ChallengeInfoInput, url: string): string {
    const type = challengeInfo.type || 'obstacle';
    switch (type) {
        case 'challenge':
            return `WAF challenge detected at ${url}. To resolve: cli-jaw browser fetch "${url}" --browser-session interactive`;
        case 'auth_required':
            return `Login required at ${url}. To resolve: cli-jaw browser fetch "${url}" --browser-session user (uses your logged-in Chrome session)`;
        case 'paywall':
            return `Paywall detected at ${url}. To resolve: cli-jaw browser fetch "${url}" --browser-session user (requires subscription in your browser)`;
        default:
            return `${type} detected at ${url}. To resolve: cli-jaw browser fetch "${url}" --browser-session interactive`;
    }
}

async function presentToUser(message: string): Promise<void> {
    process.stderr.write('\n' + message + '\n');
}

async function waitForUserSignal(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!process.stdin.readable) {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            process.stdin.removeListener('data', onData);
            reject(new Error(`human-loop timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        function onData(_data: Buffer) {
            clearTimeout(timer);
            resolve(undefined);
        }
        process.stdin.once('data', onData);
    });
}
