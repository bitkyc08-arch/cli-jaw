import { normalizeNativePermissions } from './permissions.js';

/** Jaw's literal auto policy is always-approve, not Grok's classifier-based auto. */
export function grokAcpArgs(value: unknown): string[] {
    const permissions = normalizeNativePermissions(value);
    return permissions === 'auto'
        ? ['agent', '--no-leader', '--always-approve', 'stdio']
        : ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'];
}

/** Select an existing login mechanism; never silently change auth identity. */
export function grokAuthMethod(environment: NodeJS.ProcessEnv, advertised: unknown): string {
    const method = environment['XAI_API_KEY']?.trim() ? 'xai.api_key' : 'cached_token';
    if (!Array.isArray(advertised) || !advertised.some(entry => entry && typeof entry === 'object'
        && !Array.isArray(entry) && entry['id'] === method)) throw new Error('grok_existing_auth_unavailable');
    return method;
}
