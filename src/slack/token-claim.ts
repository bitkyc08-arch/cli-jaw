import { createHash, randomBytes } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SLACK_TOKEN_CLAIM_REFRESH_MS = 30_000;
export const SLACK_TOKEN_CLAIM_FRESH_MS = 90_000;

export type SlackTokenClaim = {
    version: 1;
    claimId: string;
    home: string;
    port: string;
    pid: number;
    claimedAt: string;
    connected: boolean;
};

export type SlackTokenClaimInspection =
    | { kind: 'none' }
    | { kind: 'same_home'; claim: SlackTokenClaim }
    | { kind: 'foreign_live'; claim: SlackTokenClaim }
    | { kind: 'uncertain'; error: string };

export type SlackTokenClaimLease = {
    readonly claim: SlackTokenClaim;
    markConnected(): 'ok' | 'lost' | 'unavailable';
    markDisconnected(): void;
    release(): void;
};

export type SlackTokenClaimAcquireResult =
    | { kind: 'acquired'; lease: SlackTokenClaimLease }
    | { kind: 'same_home'; claim: SlackTokenClaim }
    | { kind: 'foreign_live'; claim: SlackTokenClaim }
    | { kind: 'unavailable'; error: string };

export type SlackTokenClaimOptions = {
    appToken: string;
    home: string;
    port: string;
    connected: boolean;
    rootDir?: string;
    now?: () => Date;
    pid?: number;
    pidAlive?: (pid: number) => boolean;
    refreshMs?: number;
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function canonicalHome(path: string): string | null {
    try { return realpathSync.native(path); }
    catch { return null; }
}

function claimsRoot(rootDir?: string): string {
    return rootDir ?? join(homedir(), '.cli-jaw-shared', 'slack-claims');
}

export function slackTokenClaimPath(appToken: string, rootDir?: string): string {
    const key = createHash('sha256').update(appToken, 'utf8').digest('hex');
    return join(claimsRoot(rootDir), `${key}.json`);
}

function parseClaim(raw: string): SlackTokenClaim | null {
    try {
        const value = JSON.parse(raw) as Partial<SlackTokenClaim>;
        if (value.version !== 1) return null;
        if (typeof value.claimId !== 'string' || !/^[0-9a-f]{32}$/.test(value.claimId)) return null;
        if (typeof value.home !== 'string' || !value.home) return null;
        if (typeof value.port !== 'string') return null;
        if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
        if (typeof value.claimedAt !== 'string' || typeof value.connected !== 'boolean') return null;
        const date = new Date(value.claimedAt);
        if (Number.isNaN(date.getTime()) || date.toISOString() !== value.claimedAt) return null;
        return value as SlackTokenClaim;
    } catch {
        return null;
    }
}

function readClaim(path: string): SlackTokenClaim | null {
    try { return parseClaim(readFileSync(path, 'utf8')); }
    catch { return null; }
}

function defaultPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isFresh(claim: SlackTokenClaim, now: Date): boolean {
    const age = now.getTime() - Date.parse(claim.claimedAt);
    return age >= 0 && age <= SLACK_TOKEN_CLAIM_FRESH_MS;
}

function classifyClaim(
    claim: SlackTokenClaim,
    home: string,
    now: Date,
    pidAlive: (pid: number) => boolean,
): SlackTokenClaimInspection {
    const claimHome = canonicalHome(claim.home);
    const currentHome = canonicalHome(home);
    if (!claimHome || !currentHome) return { kind: 'uncertain', error: 'canonical home unavailable' };
    if (claimHome === currentHome) return { kind: 'same_home', claim };
    if (!claim.connected || !isFresh(claim, now)) return { kind: 'none' };
    try {
        return pidAlive(claim.pid) ? { kind: 'foreign_live', claim } : { kind: 'none' };
    } catch (error) {
        return { kind: 'uncertain', error: errorText(error) };
    }
}

function isEexist(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

function ensureRoot(root: string): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
}

function writeExclusive(path: string, claim: SlackTokenClaim): void {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(claim)}\n`, 'utf8'); }
    finally { closeSync(fd); }
}

function writeAtomic(path: string, claim: SlackTokenClaim): void {
    const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
    } finally {
        rmSync(temp, { force: true });
    }
}

function withClaimLock<T>(path: string, body: () => T): T {
    const lockPath = `${path}.lock`;
    const fd = openSync(lockPath, 'wx', 0o600);
    closeSync(fd);
    try { return body(); }
    finally { rmSync(lockPath, { force: true }); }
}

export function inspectSlackTokenClaim(options: SlackTokenClaimOptions): SlackTokenClaimInspection {
    const path = slackTokenClaimPath(options.appToken, options.rootDir);
    try {
        const claim = readClaim(path);
        if (!claim) return { kind: 'none' };
        return classifyClaim(claim, options.home, (options.now ?? (() => new Date()))(), options.pidAlive ?? defaultPidAlive);
    } catch (error) {
        return { kind: 'uncertain', error: errorText(error) };
    }
}

export function acquireSlackTokenClaim(options: SlackTokenClaimOptions): SlackTokenClaimAcquireResult {
    const root = claimsRoot(options.rootDir);
    const path = slackTokenClaimPath(options.appToken, options.rootDir);
    const now = options.now ?? (() => new Date());
    const pid = options.pid ?? process.pid;
    const pidAlive = options.pidAlive ?? defaultPidAlive;
    const makeClaim = (): SlackTokenClaim => ({
        version: 1,
        claimId: randomBytes(16).toString('hex'),
        home: canonicalHome(options.home) ?? resolve(options.home),
        port: options.port,
        pid,
        claimedAt: now().toISOString(),
        connected: options.connected,
    });

    let claim = makeClaim();
    try {
        ensureRoot(root);
        try {
            writeExclusive(path, claim);
        } catch (error) {
            if (!isEexist(error)) throw error;
            const existing = readClaim(path);
            if (existing) {
                const observed = classifyClaim(existing, options.home, now(), pidAlive);
                if (observed.kind === 'same_home') return observed;
                if (observed.kind === 'foreign_live') return observed;
                if (observed.kind === 'uncertain' && observed.error !== 'canonical home unavailable') {
                    return { kind: 'unavailable', error: observed.error };
                }
            }
            claim = withClaimLock(path, () => {
                const latest = readClaim(path);
                if (latest) {
                    const observed = classifyClaim(latest, options.home, now(), pidAlive);
                    if (observed.kind === 'same_home' || observed.kind === 'foreign_live') {
                        throw Object.assign(new Error(observed.kind), { observed });
                    }
                    if (observed.kind === 'uncertain' && observed.error !== 'canonical home unavailable') throw new Error(observed.error);
                }
                const replacement = makeClaim();
                writeAtomic(path, replacement);
                return replacement;
            });
        }
    } catch (error) {
        const observed = (error as { observed?: SlackTokenClaimInspection }).observed;
        if (observed?.kind === 'same_home' || observed?.kind === 'foreign_live') return observed;
        const finalInspection = inspectSlackTokenClaim(options);
        if (finalInspection.kind === 'foreign_live') return finalInspection;
        return { kind: 'unavailable', error: errorText(error) };
    }

    const claimId = claim.claimId;
    let connected = claim.connected;
    let released = false;
    const update = (
        nextConnected: boolean,
        refreshTimestamp: boolean,
    ): 'ok' | 'lost' | 'unavailable' => {
        if (released) return 'lost';
        try {
            const result = withClaimLock(path, () => {
                const current = readClaim(path);
                if (!current || current.claimId !== claimId) return 'lost' as const;
                claim = {
                    ...current,
                    connected: nextConnected,
                    claimedAt: refreshTimestamp ? now().toISOString() : current.claimedAt,
                };
                writeAtomic(path, claim);
                return 'ok' as const;
            });
            connected = result === 'ok' ? nextConnected : false;
            return result;
        } catch {
            // Shared coordination is advisory. IO uncertainty must not stop Slack.
            connected = false;
            return 'unavailable';
        }
    };
    const timer = setInterval(() => {
        if (connected) update(true, true);
    }, options.refreshMs ?? SLACK_TOKEN_CLAIM_REFRESH_MS);
    timer.unref?.();

    return {
        kind: 'acquired',
        lease: {
            get claim() { return claim; },
            markConnected() { return update(true, true); },
            markDisconnected() { update(false, false); },
            release() {
                if (released) return;
                released = true;
                clearInterval(timer);
                try {
                    withClaimLock(path, () => {
                        if (readClaim(path)?.claimId === claimId) rmSync(path, { force: true });
                    });
                } catch {
                    // A stale claim expires and can be replaced on a later acquire.
                }
            },
        },
    };
}
