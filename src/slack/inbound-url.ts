import { assertPublicResolvedHost, validateFetchUrl, type ResolveHost } from '../browser/adaptive-fetch/safety.js';

export type SlackInboundUrlOptions = {
    resolveHost?: ResolveHost;
};

function normalizedHostname(url: URL): string {
    return url.hostname.toLowerCase().replace(/\.+$/, '');
}

export function isSlackDownloadHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.+$/, '');
    return host === 'slack.com'
        || host.endsWith('.slack.com')
        || host === 'slack-edge.com'
        || host.endsWith('.slack-edge.com');
}

/** Validate one authenticated download hop without inspecting signed query keys. */
export async function validateSlackDownloadUrl(
    value: string | URL,
    options: SlackInboundUrlOptions = {},
): Promise<URL> {
    let parsed: URL;
    try {
        parsed = validateFetchUrl(String(value), { allowPrivateNetwork: false });
    } catch {
        throw new Error('private_network');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('private_network');
    }
    const hostname = normalizedHostname(parsed);
    if (!isSlackDownloadHost(hostname)) throw new Error('private_network');
    if (parsed.port && parsed.port !== '443') throw new Error('private_network');
    try {
        // DNS validation needs only the host. Passing the signed Slack query to
        // the shared third-party validator would reject a legitimate signature.
        await assertPublicResolvedHost(new URL(`https://${hostname}/`), options.resolveHost);
    } catch {
        throw new Error('private_network');
    }
    return parsed;
}
