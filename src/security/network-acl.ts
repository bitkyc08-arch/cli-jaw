// ─── Network ACL ─────────────────────────────────────
// Pure functions. No express/node.http imports — string IP / URL → boolean.
// Covers RFC 1918 (10/8, 172.16/12, 192.168/16), RFC 3927 link-local (169.254/16),
// RFC 4193 ULA (fc00::/7), IPv6 link-local (fe80::/10), IPv4-mapped-v6 (::ffff:x).

/** IPv4 dotted quad → 32-bit unsigned. null if malformed. */
function parseIPv4(s: string): number | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    if ([a, b, c, d].some((o) => o > 255)) return null;
    return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/** Normalize IPv6 brackets and zone id; lowercase. */
function normalizeHostname(h: string | undefined | null): string {
    if (!h) return '';
    const noZone = (h.split('%')[0] ?? '');
    const m = /^\[([^\]]+)\]$/.exec(noZone);
    return (m && m[1] ? m[1] : noZone).toLowerCase();
}

/** Split Host header into host + port, IPv6 bracket-aware. */
function splitHostHeader(hostHeader: string): { host: string; port: string } {
    if (hostHeader.startsWith('[')) {
        const end = hostHeader.indexOf(']');
        const host = end > 0 ? hostHeader.slice(1, end) : '';
        const portPart = end > 0 ? hostHeader.slice(end + 1) : '';
        const port = portPart.startsWith(':') ? portPart.slice(1) : '';
        return { host: normalizeHostname(host), port };
    }
    const parts = hostHeader.split(':');
    return { host: normalizeHostname(parts[0] ?? ''), port: parts[1] ?? '' };
}

/** True for loopback + RFC1918 + link-local + ULA + IPv4-mapped-v6. */
export function isPrivateIP(raw: string | undefined | null): boolean {
    if (!raw) return false;
    const s = normalizeHostname(raw);
    if (!s) return false;
    if (s === '::1' || s === '127.0.0.1') return true;

    // IPv4-mapped-v6: ::ffff:192.168.1.42
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped && mapped[1]) return isPrivateIP(mapped[1]);

    // Pure IPv6 private ranges
    // fe80::/10 — first 10 bits are 1111111010, so first hextet is fe80..febf
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
    // fc00::/7 (ULA) — first 7 bits are 1111110, so first byte is fc or fd.
    // Includes Tailscale ULA fd7a:115c:a1e0::/48.
    if (s.startsWith('fc') || s.startsWith('fd')) return true;

    // IPv4 — JS bitwise returns signed Int32, so mask with `>>> 0` on both sides.
    const n = parseIPv4(s);
    if (n === null) return false;
    // 10.0.0.0/8
    if (((n & 0xff000000) >>> 0) === (0x0a000000 >>> 0)) return true;
    // 172.16.0.0/12
    if (((n & 0xfff00000) >>> 0) === (0xac100000 >>> 0)) return true;
    // 192.168.0.0/16
    if (((n & 0xffff0000) >>> 0) === (0xc0a80000 >>> 0)) return true;
    // 169.254.0.0/16 — link-local
    if (((n & 0xffff0000) >>> 0) === (0xa9fe0000 >>> 0)) return true;
    // 100.64.0.0/10 — RFC 6598 shared address space (Tailscale CGNAT).
    // Trusted-as-LAN when lanBypass=true; tailnet peers are WireGuard+IdP authenticated.
    if (((n & 0xffc00000) >>> 0) === (0x64400000 >>> 0)) return true;
    return false;
}

/** Extract host (no port) from Host header. Returns null if empty. */
export function extractHost(hostHeader: string | undefined): string | null {
    if (!hostHeader) return null;
    const { host } = splitHostHeader(hostHeader);
    return host || null;
}

/** Same-host check between Origin URL and Host header — DNS rebinding guard.
 *  Compares host AND port (default 80/443 when Origin port is implicit). */
export function originMatchesHost(originUrl: string, hostHeader: string): boolean {
    try {
        const u = new URL(originUrl);
        const originHost = normalizeHostname(u.hostname);
        const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
        const { host: reqHost, port: reqPortRaw } = splitHostHeader(hostHeader);
        const reqPort = reqPortRaw || '80';
        return originHost === reqHost && originPort === reqPort;
    } catch {
        return false;
    }
}

/** Host header acceptance — loopback always; LAN when lanAllowed=true. */
export function isAllowedHost(hostHeader: string | undefined, lanAllowed: boolean): boolean {
    const h = extractHost(hostHeader);
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (lanAllowed) {
        if (isPrivateIP(h)) return true;
        // Tailscale MagicDNS hostnames (*.ts.net) resolve to 100.64/10 peers.
        // Peer IP is the real trust boundary (server.ts requireAuth → req.ip);
        // Host header pass-through here avoids DNS-vs-IP mismatch.
        if (h.endsWith('.ts.net')) return true;
    }
    return false;
}

/** Origin URL acceptance — loopback free; LAN gated by lanAllowed + rebinding guard. */
export function isAllowedOrigin(
    originUrl: string | undefined,
    hostHeader: string | undefined,
    lanAllowed: boolean,
): boolean {
    if (!originUrl) return true; // no Origin = same-origin (curl/CLI)
    try {
        const u = new URL(originUrl);
        if (!/^https?:$/.test(u.protocol)) return false;
        const h = normalizeHostname(u.hostname);
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
        if (!lanAllowed) return false;
        if (!isPrivateIP(h) && !h.endsWith('.ts.net')) return false;
        // DNS rebinding guard: Origin host/port must equal Host header host/port.
        if (hostHeader && !originMatchesHost(originUrl, hostHeader)) return false;
        return true;
    } catch {
        return false;
    }
}
