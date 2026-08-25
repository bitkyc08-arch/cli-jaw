// Loopback identification, shared so the auth-token endpoint and the auth
// middleware cannot drift apart on what counts as "this machine".
//
// The IPv4-mapped form matters: on a dual-stack listener a connection from
// 127.0.0.1 arrives as ::ffff:127.0.0.1, and treating that as remote would lock
// the local UI out of its own token.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined | null): boolean {
    if (!address) return false;
    return LOOPBACK_ADDRESSES.has(address);
}

