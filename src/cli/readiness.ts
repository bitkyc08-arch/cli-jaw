import { execFileSync } from 'child_process';
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
            case 'agy': {
                authenticated = true; // agy performs auth checks during prompt execution.
                source = 'installed; auth checked by agy at run time';
                break;
            }
            case 'ai-e': {
                authenticated = true; // ai-e delegates auth to its selected provider runtime.
                source = 'provider-delegated';
                break;
            }
            case 'pi': {
                authenticated = true; // Pi profiles validate endpoint/key during Settings registration.
                source = info?.rejected?.some((entry: any) => String(entry.reason || '').includes('npm-exec'))
                    ? 'npm-exec fallback; profile auth validated at registration'
                    : 'profile auth validated at registration';
                break;
            }
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
            case 'cursor': {
                if (process.env["CURSOR_API_KEY"]) {
                    authenticated = true;
                    source = 'CURSOR_API_KEY';
                    break;
                }
                try {
                    const out = execFileSync(info.path || 'cursor-agent', ['status'], {
                        encoding: 'utf8',
                        timeout: 5000,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    authenticated = /logged in|authenticated/i.test(out);
                    source = authenticated ? 'cursor-agent status' : 'none';
                } catch {
                    authenticated = false;
                    source = 'none';
                }
                break;
            }
            case 'kiro-code': {
                try {
                    const out = execFileSync(info.path || 'kiro-cli', ['whoami'], {
                        encoding: 'utf8',
                        timeout: 5000,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    authenticated = /logged in|email:/i.test(out);
                    source = authenticated ? 'kiro-cli whoami' : 'none';
                } catch {
                    authenticated = false;
                    source = 'none';
                }
                break;
            }
            case 'grok': {
                try {
                    const out = execFileSync(info.path || 'grok', ['models'], {
                        encoding: 'utf8',
                        timeout: 5000,
                        stdio: ['ignore', 'pipe', 'ignore'],
                    });
                    authenticated = out.includes('grok-build') || out.includes('Available models');
                    source = authenticated ? 'grok models' : 'none';
                } catch {
                    authenticated = false;
                    source = 'none';
                }
                break;
            }
            case 'copilot': {
                authenticated = hasCopilotAuthSync();
                source = authenticated ? 'local-auth-chain' : 'none';
                break;
            }
            case 'codex-app': {
                const tokens = readCodexTokens();
                authenticated = !!tokens?.access_token;
                source = authenticated ? 'auth.json' : 'none';
                break;
            }
            case 'claude-e': {
                const claudeInfo = (detected as Record<string, any>)['claude'];
                if (!claudeInfo?.available) {
                    authenticated = false;
                    source = 'underlying claude missing';
                    break;
                }
                const claudeCreds = readClaudeCreds();
                authenticated = !!claudeCreds?.token;
                if (claudeCreds?.source === 'cloud-provider-env') authenticated = true;
                source = claudeCreds?.source ?? 'none';
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

const DEFAULT_ORDER: readonly CliEngine[] = ['pi', 'claude', 'claude-e', 'agy', 'codex', 'codex-app', 'cursor', 'kiro-code', 'copilot', 'grok', 'opencode', 'ai-e'];

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
