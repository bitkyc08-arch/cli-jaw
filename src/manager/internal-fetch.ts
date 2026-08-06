export const JAW_INTERNAL_HEADER = 'x-jaw-internal';

/**
 * Marks manager-to-instance traffic for rate-budget classification. This is an
 * identity declaration, not authority: requireAuth keeps the loopback trust
 * boundary, spoofing only changes budget class, and proxy.ts strips the marker.
 */
export function withInternalHeader(init?: RequestInit): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set(JAW_INTERNAL_HEADER, '1');
    return { ...init, headers };
}

export function internalFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, withInternalHeader(init));
}
