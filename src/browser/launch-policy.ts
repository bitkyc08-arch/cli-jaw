export type BrowserStartMode = 'manual' | 'agent' | 'debug';

export interface BrowserLaunchPolicyInput {
    mode?: BrowserStartMode | string | null | undefined;
    headless?: boolean;
    envHeadless?: boolean;
}

export interface BrowserLaunchPolicy {
    mode: BrowserStartMode;
    allowLaunch: boolean;
    headless: boolean;
    denyReason?: string;
}

export const DEBUG_CONSOLE_ONLY_MESSAGE =
    'Debug mode does not launch a test browser. Use the Web UI debug console instead.';

export function normalizeBrowserStartMode(mode: BrowserLaunchPolicyInput['mode']): BrowserStartMode {
    if (mode === 'agent' || mode === 'debug' || mode === 'manual') return mode;
    return 'manual';
}

export function resolveLaunchPolicy(input: BrowserLaunchPolicyInput = {}): BrowserLaunchPolicy {
    const mode = normalizeBrowserStartMode(input.mode);
    const envHeadless = input.envHeadless ?? process.env.CHROME_HEADLESS === '1';
    const requestedHeadless = input.headless === true || envHeadless;

    if (mode === 'debug') {
        return {
            mode,
            allowLaunch: false,
            headless: false,
            denyReason: DEBUG_CONSOLE_ONLY_MESSAGE,
        };
    }

    if (mode === 'agent') {
        return {
            mode,
            allowLaunch: true,
            headless: true,
        };
    }

    return {
        mode,
        allowLaunch: true,
        headless: requestedHeadless,
    };
}
