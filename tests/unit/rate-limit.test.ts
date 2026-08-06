import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyClient,
    classifyPath,
    createRateLimiter,
    type RateClientClass,
    type RateLimitConfig,
    type RatePathClass,
} from '../../src/core/rate-limit.ts';
import { rewriteUpstreamRequestHeaders } from '../../src/manager/proxy.ts';

const WINDOW_MS = 60_000;

function budgets(defaultLimit: number, overrides: Partial<Record<RateClientClass, Partial<Record<RatePathClass, number>>>> = {}): RateLimitConfig['budgets'] {
    const result: RateLimitConfig['budgets'] = {
        cli: { poll: defaultLimit, mutate: defaultLimit, general: defaultLimit },
        manager: { poll: defaultLimit, mutate: defaultLimit, general: defaultLimit },
        browser: { poll: defaultLimit, mutate: defaultLimit, general: defaultLimit },
        lan: { poll: defaultLimit, mutate: defaultLimit, general: defaultLimit },
        remote: { poll: defaultLimit, mutate: defaultLimit, general: defaultLimit },
    };
    for (const cls of Object.keys(overrides) as RateClientClass[]) {
        result[cls] = { ...result[cls], ...overrides[cls] };
    }
    return result;
}

function classifier(ip: string, authHeader?: string, internalHeader?: string, lanAllowed = false) {
    return classifyClient({
        ip,
        ...(authHeader === undefined ? {} : { authHeader }),
        ...(internalHeader === undefined ? {} : { internalHeader }),
        authToken: 'secret',
        lanAllowed,
        isPrivateIp: value => value.startsWith('192.168.'),
    });
}

test('classifyClient identifies cli, manager, browser, and remote callers', () => {
    assert.equal(classifier('127.0.0.1', 'Bearer secret'), 'cli');
    assert.equal(classifier('::1', undefined, '1'), 'manager');
    assert.equal(classifier('::ffff:127.0.0.1'), 'browser');
    assert.equal(classifier('203.0.113.10'), 'remote');
});

test('classifyClient gives network position precedence over spoofable headers', () => {
    assert.equal(classifier('203.0.113.10', 'Bearer secret'), 'remote');
    assert.equal(classifier('203.0.113.10', undefined, '1'), 'remote');
});

test('classifyClient grants the lan class only when LAN bypass is enabled', () => {
    assert.equal(classifier('192.168.1.8', undefined, undefined, true), 'lan');
    assert.equal(classifier('192.168.1.8', undefined, undefined, false), 'remote');
});

test('classifyPath separates polling and mutation traffic', () => {
    assert.equal(classifyPath('GET', '/api/messages/latest'), 'poll');
    assert.equal(classifyPath('POST', '/api/chat-sessions/1/switch'), 'mutate');
});

test('exhaustion returns an admissible retry delay and logs only the first rejection', () => {
    const limiter = createRateLimiter({ budgets: budgets(2) });
    assert.deepEqual(limiter.check('ip', 'browser', 'poll', 0), { allowed: true });
    assert.deepEqual(limiter.check('ip', 'browser', 'poll', 0), { allowed: true });
    const first = limiter.check('ip', 'browser', 'poll', 0);
    assert.equal(first.allowed, false);
    if (first.allowed) return;
    assert.ok(first.retryAfterSec > 0);
    assert.equal(first.shouldLog, true);
    const repeated = limiter.check('ip', 'browser', 'poll', 0);
    assert.equal(repeated.allowed, false);
    if (repeated.allowed) return;
    assert.equal(repeated.shouldLog, false);
    assert.deepEqual(limiter.check('ip', 'browser', 'poll', first.retryAfterSec * 1_000), { allowed: true });
});

test('browser exhaustion does not consume cli capacity for the same IP', () => {
    const limiter = createRateLimiter({ budgets: budgets(1) });
    assert.equal(limiter.check('127.0.0.1', 'browser', 'poll', 0).allowed, true);
    assert.equal(limiter.check('127.0.0.1', 'browser', 'poll', 0).allowed, false);
    assert.equal(limiter.check('127.0.0.1', 'cli', 'poll', 0).allowed, true);
});

test('sliding window handles boundaries, idle reset, and two-window sweep retention', () => {
    const limiter = createRateLimiter({ budgets: budgets(1) });
    assert.equal(limiter.check('edge', 'browser', 'poll', 0).allowed, true);
    assert.equal(limiter.check('edge', 'browser', 'poll', WINDOW_MS - 1).allowed, false);
    assert.equal(limiter.check('edge', 'browser', 'poll', WINDOW_MS).allowed, false);
    assert.equal(limiter.check('edge', 'browser', 'poll', WINDOW_MS + 1).allowed, true);

    const idle = createRateLimiter({ budgets: budgets(1) });
    assert.equal(idle.check('idle', 'browser', 'poll', 0).allowed, true);
    assert.equal(idle.check('idle', 'browser', 'poll', 2 * WINDOW_MS).allowed, true);

    const swept = createRateLimiter({ budgets: budgets(1) });
    assert.equal(swept.check('sweep', 'browser', 'poll', 0).allowed, true);
    swept.sweep(WINDOW_MS);
    assert.equal(swept.check('sweep', 'browser', 'poll', WINDOW_MS).allowed, false,
        'sweep must preserve the previous window needed for interpolation');
});

test('dashboard proxy strips inbound manager identity', () => {
    const headers = rewriteUpstreamRequestHeaders({
        host: 'localhost:24576',
        'x-jaw-internal': '1',
    }, 3457);
    assert.equal(headers['x-jaw-internal'], undefined);
});

test('non-loopback traffic shares a 120 request total bucket while loopback classes do not', () => {
    const limiter = createRateLimiter();
    for (let index = 0; index < 100; index++) {
        assert.equal(limiter.check('lan-ip', 'lan', 'poll', 0).allowed, true);
    }
    for (let index = 0; index < 20; index++) {
        assert.equal(limiter.check('lan-ip', 'lan', 'mutate', 0).allowed, true);
    }
    assert.equal(limiter.check('lan-ip', 'lan', 'mutate', 0).allowed, false);

    for (let index = 0; index < 300; index++) {
        assert.equal(limiter.check('loopback', 'browser', 'poll', 0).allowed, true);
    }
    assert.equal(limiter.check('loopback', 'browser', 'mutate', 0).allowed, true);
});

test('composite checks are atomic and use the maximum violated retry delay', () => {
    const totalBlocked = createRateLimiter({
        budgets: budgets(10, { lan: { poll: 1 } }),
        nonLoopbackTotalLimit: 1,
    });
    assert.equal(totalBlocked.check('a', 'lan', 'mutate', 0).allowed, true);
    assert.equal(totalBlocked.check('a', 'lan', 'poll', 1_000).allowed, false);
    assert.equal(totalBlocked.check('a', 'lan', 'poll', WINDOW_MS + 1).allowed, true,
        'a total-bucket rejection must not consume the poll bucket');

    const pathBlocked = createRateLimiter({
        budgets: budgets(10, { lan: { poll: 1 } }),
        nonLoopbackTotalLimit: 2,
    });
    assert.equal(pathBlocked.check('b', 'lan', 'poll', 0).allowed, true);
    assert.equal(pathBlocked.check('b', 'lan', 'poll', 1_000).allowed, false);
    assert.equal(pathBlocked.check('b', 'lan', 'mutate', 1_000).allowed, true,
        'a path-bucket rejection must not consume the total bucket');

    const config = { budgets: budgets(10, { lan: { poll: 1 } }), nonLoopbackTotalLimit: 2 };
    const combined = createRateLimiter(config);
    const pathOnly = createRateLimiter({ budgets: budgets(10, { browser: { poll: 1 } }) });
    const totalOnly = createRateLimiter(config);
    for (const limiter of [combined, totalOnly]) {
        assert.equal(limiter.check('c', 'lan', 'poll', 0).allowed, true);
        assert.equal(limiter.check('c', 'lan', 'mutate', 30_000).allowed, true);
    }
    assert.equal(pathOnly.check('c', 'browser', 'poll', 0).allowed, true);
    const both = combined.check('c', 'lan', 'poll', 30_000);
    const path = pathOnly.check('c', 'browser', 'poll', 30_000);
    const total = totalOnly.check('c', 'lan', 'general', 30_000);
    assert.equal(both.allowed, false);
    assert.equal(path.allowed, false);
    assert.equal(total.allowed, false);
    if (both.allowed || path.allowed || total.allowed) return;
    assert.equal(both.retryAfterSec, Math.max(path.retryAfterSec, total.retryAfterSec));
});
