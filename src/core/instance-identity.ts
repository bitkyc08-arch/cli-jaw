import { createHash, randomBytes } from 'node:crypto';

/**
 * Instance identity for service ownership (#370).
 *
 * Two questions must be answerable before any destructive lifecycle action:
 * "is this process ours?" and "is the thing answering on that port ours?".
 * Today `verifyOwnership` checks home + pid + start time, which cannot distinguish
 * two homes on different ports, or the same executable launched with different
 * arguments.
 */

/**
 * A launch fingerprint over the full command identity.
 *
 * LENGTH-FRAMED on purpose. Hashing a plain join lets different component splits
 * collide — ['a','bc'] and ['ab','c'] would hash identically — and hashing only
 * (home, port, argv0) gives two processes with the same executable but different
 * arguments the same fingerprint, so a foreign command line would pass as ours.
 */
export function launchFingerprint(
    canonicalHome: string,
    port: number,
    execPath: string,
    args: string[] = [],
): string {
    const parts = [canonicalHome, String(port), execPath, ...args];
    const framed = parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('');
    return createHash('sha256').update(framed, 'utf8').digest('hex');
}

export type InstanceIdentity = {
    id: string;
    createdAt: string;
};

export type IdentityDeps = {
    readFile(path: string): string;
    /** Exclusive create ('wx'): must throw when the file already exists. */
    createExclusive(path: string, contents: string): void;
    now(): Date;
    randomId(): string;
};

export function generateInstanceId(): string {
    // 128 bits, not a digest of (home, port): common Windows home paths form a small
    // guessable domain, and this value is published on an UNAUTHENTICATED health
    // endpoint, where a digest could be enumerated offline to recover the account.
    return randomBytes(16).toString('hex');
}

export function parseIdentity(raw: string): InstanceIdentity | null {
    try {
        const parsed = JSON.parse(raw) as Partial<InstanceIdentity>;
        if (typeof parsed.id !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.id)) return null;
        if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) return null;
        return { id: parsed.id, createdAt: parsed.createdAt };
    } catch {
        return null;
    }
}

/**
 * Create-or-load, with exactly one creator.
 *
 * Temp-file-plus-rename is NOT enough: two racing installers can each rename, and the
 * loser silently replaces the winner's id — after which the two disagree about which
 * instance they own. An exclusive create makes the race decidable: the loser gets
 * EEXIST and adopts what it reads. Every caller returns the id it READ, never the one
 * it intended to write.
 */
export function ensureInstanceIdentity(path: string, deps: IdentityDeps): InstanceIdentity {
    const existing = tryRead(path, deps);
    if (existing) return existing;

    const candidate: InstanceIdentity = {
        id: deps.randomId(),
        createdAt: deps.now().toISOString(),
    };
    try {
        deps.createExclusive(path, `${JSON.stringify(candidate, null, 2)}\n`);
        return candidate;
    } catch {
        // Someone else won, or the file is unreadable/corrupt.
        const afterRace = tryRead(path, deps);
        if (afterRace) return afterRace;
        throw new Error(`instance identity at ${path} exists but is unreadable or corrupt`);
    }
}

function tryRead(path: string, deps: IdentityDeps): InstanceIdentity | null {
    try {
        return parseIdentity(deps.readFile(path));
    } catch {
        return null;
    }
}

export type HealthIdentity = { id: string; port: number };
export type OwnershipCheck = 'owned' | 'conflict' | 'unverified-identity';

/**
 * Compare a health response against the locally loaded identity.
 *
 * A missing local identity is `unverified-identity`, never `owned`: a reader must not
 * regenerate (that authority belongs to install/start alone) and must not assume
 * ownership it cannot prove. Anything answering with a different id is a `conflict`,
 * and no destructive action may proceed on either result.
 */
export function checkHealthOwnership(
    local: InstanceIdentity | null,
    expectedPort: number,
    response: HealthIdentity | null,
): OwnershipCheck {
    if (!local) return 'unverified-identity';
    if (!response) return 'unverified-identity';
    if (response.id !== local.id) return 'conflict';
    if (response.port !== expectedPort) return 'conflict';
    return 'owned';
}

