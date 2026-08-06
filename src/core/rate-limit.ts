import type express from 'express';

export type RateClientClass = 'cli' | 'manager' | 'browser' | 'lan' | 'remote';
export type RatePathClass = 'poll' | 'mutate' | 'general';

export type RateDecision = { allowed: true } | {
    allowed: false;
    retryAfterSec: number;
    limit: number;
    remaining: 0;
    shouldLog: boolean;
};

type RateBudgets = Record<RateClientClass, Record<RatePathClass, number>>;

export interface RateLimitConfig {
    windowMs: number;
    budgets: RateBudgets;
    nonLoopbackTotalLimit: number;
}

interface Bucket {
    windowStart: number;
    count: number;
    prevCount: number;
}

interface BucketView extends Bucket {
    effective: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
    windowMs: 60_000,
    budgets: {
        cli: { poll: 600, mutate: 240, general: 600 },
        manager: { poll: 600, mutate: 240, general: 600 },
        browser: { poll: 300, mutate: 120, general: 300 },
        lan: { poll: 120, mutate: 120, general: 120 },
        remote: { poll: 60, mutate: 30, general: 120 },
    },
    nonLoopbackTotalLimit: 120,
};

const EXEMPT_PATH_PREFIXES = [
    '/api/orchestrate/worker-runs',
    '/api/orchestrate/worker/',
    '/api/orchestrate/worker-progress',
];

function isLoopback(ip: string): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function classifyClient(opts: {
    ip: string;
    authHeader?: string;
    internalHeader?: string;
    authToken: string;
    lanAllowed: boolean;
    isPrivateIp: (ip: string) => boolean;
}): RateClientClass {
    // Network position is authoritative: remote headers cannot buy a loopback budget.
    if (!isLoopback(opts.ip)) {
        if (opts.lanAllowed && opts.isPrivateIp(opts.ip)) return 'lan';
        return 'remote';
    }
    if (opts.authHeader === `Bearer ${opts.authToken}`) return 'cli';
    if (opts.internalHeader !== undefined) return 'manager';
    return 'browser';
}

export function classifyPath(method: string, path: string): RatePathClass {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'mutate';
    if (path === '/api/status'
        || path === '/api/health'
        || path === '/api/messages/latest'
        || path === '/api/goal') return 'poll';
    return 'general';
}

function viewBucket(bucket: Bucket, now: number, windowMs: number): BucketView {
    let { windowStart, count, prevCount } = bucket;
    const age = Math.max(0, now - windowStart);
    if (age >= 2 * windowMs) {
        windowStart += windowMs * Math.floor(age / windowMs);
        count = 0;
        prevCount = 0;
    } else if (age >= windowMs) {
        windowStart += windowMs * Math.floor(age / windowMs);
        prevCount = count;
        count = 0;
    }
    const elapsed = Math.max(0, now - windowStart);
    const previousWeight = Math.max(0, Math.min(1, 1 - elapsed / windowMs));
    return { windowStart, count, prevCount, effective: count + prevCount * previousWeight };
}

function retryAfterSec(bucket: Bucket, limit: number, now: number, windowMs: number): number {
    const maxSeconds = Math.ceil(2 * windowMs / 1_000) + 1;
    for (let seconds = 1; seconds <= maxSeconds; seconds++) {
        if (viewBucket(bucket, now + seconds * 1_000, windowMs).effective < limit) return seconds;
    }
    return maxSeconds;
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}): {
    check(key: string, cls: RateClientClass, pathClass: RatePathClass, now?: number): RateDecision;
    sweep(now?: number): void;
} {
    const resolved: RateLimitConfig = { ...DEFAULT_CONFIG, ...config };
    const buckets = new Map<string, Bucket>();
    const loggedWindows = new Map<string, number>();

    function check(
        key: string,
        cls: RateClientClass,
        pathClass: RatePathClass,
        now = Date.now(),
    ): RateDecision {
        const pathKey = `${cls}:${key}:${pathClass}`;
        const specs = [{ key: pathKey, limit: resolved.budgets[cls][pathClass] }];
        if (cls === 'lan' || cls === 'remote') {
            specs.push({ key: `${cls}:${key}:total`, limit: resolved.nonLoopbackTotalLimit });
        }

        // Peek every participating bucket before committing so a rejection consumes no quota.
        const views = specs.map(spec => {
            const bucket = buckets.get(spec.key) ?? { windowStart: now, count: 0, prevCount: 0 };
            return { ...spec, bucket, view: viewBucket(bucket, now, resolved.windowMs) };
        });
        const violated = views.filter(item => item.view.effective >= item.limit);
        if (violated.length > 0) {
            let retry = 0;
            let limit = violated[0]!.limit;
            let shouldLog = false;
            for (const item of violated) {
                const needed = retryAfterSec(item.bucket, item.limit, now, resolved.windowMs);
                if (needed > retry) {
                    retry = needed;
                    limit = item.limit;
                }
                if (loggedWindows.get(item.key) !== item.view.windowStart) {
                    shouldLog = true;
                    loggedWindows.set(item.key, item.view.windowStart);
                }
            }
            return { allowed: false, retryAfterSec: retry, limit, remaining: 0, shouldLog };
        }

        for (const item of views) {
            buckets.set(item.key, {
                windowStart: item.view.windowStart,
                count: item.view.count + 1,
                prevCount: item.view.prevCount,
            });
        }
        return { allowed: true };
    }

    function sweep(now = Date.now()): void {
        for (const [key, bucket] of buckets) {
            if (now - bucket.windowStart >= 2 * resolved.windowMs) {
                buckets.delete(key);
                loggedWindows.delete(key);
            }
        }
    }

    return { check, sweep };
}

export function createRateLimitMiddleware(opts: {
    authToken: string;
    lanAllowed: () => boolean;
    isPrivateIp: (ip: string) => boolean;
    limiter?: ReturnType<typeof createRateLimiter>;
}): express.RequestHandler {
    const limiter = opts.limiter ?? createRateLimiter();
    return (req, res, next) => {
        if (!req.path.startsWith('/api/')) return next();
        if (req.path === '/api/events') return next();
        if (EXEMPT_PATH_PREFIXES.some(prefix => req.path.startsWith(prefix))) return next();

        const ip = req.ip || req.socket?.remoteAddress || '';
        const internalHeader = req.headers['x-jaw-internal'];
        const cls = classifyClient({
            ip,
            ...(req.headers.authorization === undefined
                ? {}
                : { authHeader: req.headers.authorization }),
            ...(internalHeader === undefined
                ? {}
                : { internalHeader: Array.isArray(internalHeader) ? internalHeader.join(', ') : internalHeader }),
            authToken: opts.authToken,
            lanAllowed: opts.lanAllowed(),
            isPrivateIp: opts.isPrivateIp,
        });
        const decision = limiter.check(ip, cls, classifyPath(req.method, req.path));
        if (decision.allowed) return next();

        res.setHeader('Retry-After', String(decision.retryAfterSec));
        res.setHeader(
            'RateLimit',
            `limit=${decision.limit}, remaining=${decision.remaining}, reset=${decision.retryAfterSec}`,
        );
        res.setHeader('Cache-Control', 'no-store');
        if (decision.shouldLog) {
            console.warn(`[rate-limit] ${ip} (${cls}) exceeded (first blocked: ${req.method} ${req.path})`);
        }
        return res.status(429).json({ error: 'rate_limit', retryAfterSec: decision.retryAfterSec });
    };
}
