import { detectAllCli } from '../core/config.js';
import { readClaudeCreds, readCodexTokens, readGeminiAccount } from '../routes/quota.js';
import { hasCopilotAuthSync } from '../../lib/quota-copilot.js';
import { CLI_KEYS, DEFAULT_CLI } from './registry.js';
import type { CliEngine } from '../types/cli-engine.js';

export interface CliReadiness {
    cli: string;
    installed: boolean;
    authenticated: boolean;
    source: string;
}

export function getCliReadiness(): CliReadiness[] {
    const detected = detectAllCli();
    const results: CliReadiness[] = [];

    for (const cli of CLI_KEYS) {
        const info = (detected as Record<string, any>)[cli];
        const installed = !!info?.available;
        let authenticated = false;
        let source = 'none';

        if (!installed) {
            results.push({ cli, installed, authenticated, source });
            continue;
        }

        switch (cli) {
            case 'claude': {
                const creds = readClaudeCreds();
                authenticated = !!creds?.token;
                if (creds?.source === 'cloud-provider-env') authenticated = true;
                source = creds?.source ?? 'none';
                break;
            }
            case 'codex': {
                const tokens = readCodexTokens();
                authenticated = !!tokens?.access_token;
                source = authenticated ? 'auth.json' : 'none';
                break;
            }
            case 'gemini': {
                const gem = readGeminiAccount();
                authenticated = !!gem?.account?.email;
                source = authenticated ? 'oauth_creds.json' : 'none';
                break;
            }
            case 'copilot': {
                authenticated = hasCopilotAuthSync();
                source = authenticated ? 'local-auth-chain' : 'none';
                break;
            }
            case 'opencode': {
                authenticated = true; // opencode has no separate auth
                source = 'installed';
                break;
            }
        }

        results.push({ cli, installed, authenticated, source });
    }

    return results;
}

const DEFAULT_ORDER: readonly CliEngine[] = ['claude', 'codex', 'copilot', 'gemini', 'opencode'];

export function pickFirstReadyCli(order: readonly CliEngine[] = DEFAULT_ORDER): CliEngine {
    const readiness = getCliReadiness();
    // Tier 1: installed + authenticated
    for (const cli of order) {
        const r = readiness.find(x => x.cli === cli);
        if (r?.installed && r?.authenticated) return cli;
    }
    // Tier 2: installed only
    for (const cli of order) {
        const r = readiness.find(x => x.cli === cli);
        if (r?.installed) return cli;
    }
    // Tier 3: fallback
    return DEFAULT_CLI ?? 'claude';
}
