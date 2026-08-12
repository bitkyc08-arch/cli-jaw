import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { registerSearchRoutes } from '../../src/routes/search.ts';
import { SearchCoordinator } from '../../src/search/coordinator.ts';
import {
    createOffProvider,
    providerEnvelope,
    SearchProviderRegistry,
    type ProviderSearchOptions,
    type SearchProvider,
} from '../../src/search/provider.ts';
import type {
    ConcreteCorpus,
    ProviderStatus,
    SearchHit,
    SearchQuery,
    SearchResultEnvelope,
} from '../../src/search/contract.ts';

type SearchImplementation = (
    query: SearchQuery,
    opts: ProviderSearchOptions,
    provider: FakeProvider,
) => Promise<SearchResultEnvelope> | SearchResultEnvelope;

class FakeProvider implements SearchProvider {
    readonly calls: ProviderSearchOptions[] = [];

    constructor(
        readonly id: string,
        readonly corpus: ConcreteCorpus,
        private readonly implementation: SearchImplementation,
        private readonly providerStatus: ProviderStatus = 'ready',
        private readonly failureCode: 'notes_search_unavailable' | null = null,
    ) {}

    status(): ProviderStatus {
        return this.providerStatus;
    }

    safeFailureCode(): 'notes_search_unavailable' | null {
        return this.failureCode;
    }

    async search(query: SearchQuery, opts: ProviderSearchOptions): Promise<SearchResultEnvelope> {
        this.calls.push(opts);
        return this.implementation(query, opts, this);
    }
}

const hit = (provider: string, key: string, session?: string): SearchHit => ({
    corpus: 'chat',
    provider,
    key,
    ...(session !== undefined ? { session } : {}),
    snippet: `hit-${key}`,
    ranking: { mode: 'recency', sourceRank: Number(key) || 1 },
});

function registryOf(...providers: SearchProvider[]): SearchProviderRegistry {
    const registry = new SearchProviderRegistry();
    for (const provider of providers) registry.register(provider);
    return registry;
}

function testAuth(req: Request, res: Response, next: NextFunction): void {
    if (req.header('x-test-network') !== 'remote' || req.header('authorization') === 'Bearer valid') next();
    else res.status(401).json({ error: 'Unauthorized' });
}

async function withServer(
    coordinator: SearchCoordinator,
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    registerSearchRoutes(app, testAuth, coordinator);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function json(response: Response | globalThis.Response): Promise<Record<string, any>> {
    return await response.json() as Record<string, any>;
}

test('registry rejects duplicate ids and preserves registration order', () => {
    const a = new FakeProvider('a', 'chat', (query, _opts, provider) => providerEnvelope(provider, query, []));
    const b = createOffProvider('b', 'memory');
    const registry = registryOf(a, b);
    assert.deepEqual(registry.list().map(provider => provider.id), ['a', 'b']);
    assert.throws(() => registry.register(a), /duplicate search provider: a/);
});

test('route defaults to cross-session chat search and sessionFilter narrows it', async () => {
    const rows = [hit('chat', '1', 's1'), hit('chat', '2', 's2')];
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) => {
        const selected = query.sessionFilter === undefined
            ? rows : rows.filter(row => row.session === query.sessionFilter);
        return providerEnvelope(provider, query, selected);
    });
    await withServer(new SearchCoordinator(registryOf(chat)), async baseUrl => {
        const all = await json(await fetch(`${baseUrl}/api/search?q=needle&corpus=chat`));
        assert.deepEqual(all.groups[0].hits.map((row: SearchHit) => row.session), ['s1', 's2']);
        const filtered = await json(await fetch(
            `${baseUrl}/api/search?q=needle&corpus=chat&sessionFilter=s1`,
        ));
        assert.deepEqual(filtered.groups[0].hits.map((row: SearchHit) => row.session), ['s1']);
    });
});

test('route applies auth before search while preserving loopback and valid-bearer behavior', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, []));
    await withServer(new SearchCoordinator(registryOf(chat)), async baseUrl => {
        const remote = await fetch(`${baseUrl}/api/search?q=needle&corpus=chat`, {
            headers: { 'x-test-network': 'remote' },
        });
        assert.equal(remote.status, 401);
        assert.equal(chat.calls.length, 0, 'unauthenticated request must not reach a provider');
        assert.equal((await fetch(`${baseUrl}/api/search?q=needle&corpus=chat`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/search?q=needle&corpus=chat`, {
            headers: { 'x-test-network': 'remote', authorization: 'Bearer valid' },
        })).status, 200);
    });
    const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    assert.match(serverSource, /registerSearchRoutes\(app, requireAuth, new SearchCoordinator\(searchRegistry\)\)/);
});

test('route rejects unknown corpus and out-of-range limit/context as invalid_query', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, []));
    await withServer(new SearchCoordinator(registryOf(chat)), async baseUrl => {
        for (const suffix of ['corpus=other', 'corpus=chat&limit=0', 'corpus=chat&limit=101',
            'corpus=chat&context=6', 'corpus=chat&context=-1']) {
            const response = await fetch(`${baseUrl}/api/search?q=needle&${suffix}`);
            assert.equal(response.status, 400, suffix);
            assert.equal((await json(response)).code, 'invalid_query', suffix);
        }
    });
});

test('malformed base64, JSON array, and negative provider offset cursors return invalid_cursor', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, String(opts.offset + 1))], [], true));
    await withServer(new SearchCoordinator(registryOf(chat)), async baseUrl => {
        const first = await json(await fetch(`${baseUrl}/api/search?q=needle&corpus=chat&limit=1`));
        assert.equal(typeof first.page.nextCursor, 'string');
        const negative = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString('utf8'));
        negative.providers.chat.offset = -1;
        const cursors = [
            'not%25base64',
            Buffer.from(JSON.stringify([])).toString('base64url'),
            Buffer.from(JSON.stringify(negative)).toString('base64url'),
        ];
        for (const cursor of cursors) {
            const response = await fetch(
                `${baseUrl}/api/search?q=needle&corpus=chat&limit=1&cursor=${cursor}`,
            );
            assert.equal(response.status, 400, cursor);
            assert.deepEqual(await response.json(), { code: 'invalid_cursor', error: 'invalid_cursor' });
        }
    });
});

test('provider rejection is partial success and rejected provider is not retried on the next page', async () => {
    const failing = new FakeProvider('failing', 'chat', async () => { throw new Error('planned failure'); });
    const steady = new FakeProvider('steady', 'chat', (query, opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, String(opts.offset + 1))], [], opts.offset < 1));
    await withServer(new SearchCoordinator(registryOf(failing, steady)), async baseUrl => {
        const firstResponse = await fetch(`${baseUrl}/api/search?q=needle&corpus=chat&limit=2`);
        assert.equal(firstResponse.status, 200);
        const first = await json(firstResponse);
        assert.equal(first.groups[0].hits[0].provider, 'steady');
        assert.ok(first.warnings.some((warning: any) =>
            warning.code === 'provider_failed' && warning.provider === 'failing'));
        assert.ok(first.providers.some((provider: any) =>
            provider.id === 'failing' && provider.status === 'error'));
        assert.equal(typeof first.page.nextCursor, 'string');

        const second = await json(await fetch(
            `${baseUrl}/api/search?q=needle&corpus=chat&limit=2&cursor=${first.page.nextCursor}`,
        ));
        assert.equal(failing.calls.length, 1);
        assert.deepEqual(steady.calls.map(call => call.offset), [0, 1]);
        assert.equal(second.page.hasMore, false);
        assert.equal(second.page.nextCursor, null);
    });
});

test('exhausted providers are skipped while remaining provider offsets advance', async () => {
    const finite = new FakeProvider('finite', 'chat', (query, opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, String(opts.offset + 1))], [], false));
    const paged = new FakeProvider('paged', 'chat', (query, opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, String(opts.offset + 1))], [], opts.offset < 1));
    const coordinator = new SearchCoordinator(registryOf(finite, paged));
    const first = await coordinator.search({ query: 'needle', corpus: 'chat', limit: 2 });
    assert.equal(first.page.hasMore, true);
    assert.ok(first.page.nextCursor);
    const second = await coordinator.search({
        query: 'needle', corpus: 'chat', limit: 2, cursor: first.page.nextCursor,
    });
    assert.equal(finite.calls.length, 1);
    assert.deepEqual(paged.calls.map(call => call.offset), [0, 1]);
    assert.equal(second.page.hasMore, false);
});

test('off placeholders consume no budget and remain visible with provider_off warnings', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, opts, provider) => {
        const hits = Array.from({ length: opts.limit }, (_, index) =>
            hit(provider.id, String(opts.offset + index + 1)));
        return providerEnvelope(provider, query, hits, [], true);
    });
    const coordinator = new SearchCoordinator(registryOf(
        chat,
        createOffProvider('memory-placeholder', 'memory'),
        createOffProvider('wiki-placeholder', 'wiki'),
    ));
    const result = await coordinator.search({ query: 'needle', corpus: 'all', limit: 20 });
    assert.equal(chat.calls[0]?.limit, 20);
    assert.equal(result.groups.flatMap(group => group.hits).length, 20);
    assert.deepEqual(result.providers.filter(provider => provider.status === 'off').map(provider => provider.id),
        ['memory-placeholder', 'wiki-placeholder']);
    assert.equal(result.warnings.filter(warning => warning.code === 'provider_off').length, 2);
});

test('when the only ready provider is exhausted, off placeholders do not keep hasMore true', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, '1')], [], false));
    const coordinator = new SearchCoordinator(registryOf(
        chat,
        createOffProvider('memory-placeholder', 'memory'),
        createOffProvider('wiki-placeholder', 'wiki'),
    ));
    const result = await coordinator.search({ query: 'needle', corpus: 'all', limit: 20 });
    assert.equal(result.page.hasMore, false);
    assert.equal(result.page.nextCursor, null);
});

// A provider that reports status 'error' is neither off nor ready. Before this
// case was handled it never entered cursor state at all, so hasMore ("is any
// registered provider unexhausted?") stayed true forever and the response
// offered a next page that could never contain anything.
test('a provider already in error state is terminalized instead of holding pagination open', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, '1')], [], false));
    const broken = new FakeProvider('memory-broken', 'memory', (query, _opts, provider) =>
        providerEnvelope(provider, query, [], [], false), 'error');
    const coordinator = new SearchCoordinator(registryOf(chat, broken));

    const result = await coordinator.search({ query: 'needle', corpus: 'all', limit: 20 });

    assert.equal(broken.calls.length, 0, 'an error provider must not be searched');
    assert.equal(result.page.hasMore, false, 'an error provider must not keep pagination alive');
    assert.equal(result.page.nextCursor, null);
    assert.deepEqual(
        result.providers.filter(provider => provider.status === 'error').map(provider => provider.id),
        ['memory-broken'],
        'the error provider must still be visible in the inventory',
    );
    // corpus=all also warns that wiki is unregistered, so assert on the provider.
    assert.deepEqual(
        result.warnings.filter(warning => warning.provider === 'memory-broken').map(warning => warning.code),
        ['provider_failed'],
    );
});

// The cursor is client-held. Number.isInteger(1e100) is true, so an absurd
// offset would otherwise reach the provider as a SQL OFFSET.
test('cursor validation rejects unsafe offsets, unknown fields, and oversized payloads', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, '1')], [], true));
    const coordinator = new SearchCoordinator(registryOf(chat));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    const rejected = [
        { v: 1, hash: '', providers: { chat: { offset: 1e100, exhausted: false } } },
        { v: 1, hash: '', providers: { chat: { offset: 1.5, exhausted: false } } },
        { v: 1, hash: '', providers: { chat: { offset: 0, exhausted: 'no' } } },
        { v: 1, hash: '', providers: { chat: { offset: 0, exhausted: false, extra: 1 } } },
        { v: 1, hash: '', providers: { chat: { offset: 10_000_000, exhausted: false } } },
    ];
    for (const cursor of rejected) {
        await assert.rejects(
            () => coordinator.search({ query: 'needle', corpus: 'chat', cursor: encode(cursor) }),
            (error: { code?: string }) => error.code === 'invalid_cursor',
            `must reject ${JSON.stringify(cursor.providers)}`,
        );
    }

    const oversized = { v: 1, hash: '', providers: Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [`p${i}`, { offset: 0, exhausted: false }])) };
    await assert.rejects(
        () => coordinator.search({ query: 'needle', corpus: 'chat', cursor: encode(oversized) }),
        (error: { code?: string }) => error.code === 'invalid_cursor',
        'too many provider entries must be rejected',
    );
});

// Provider errors can carry SQL, paths, upstream bodies, or credentials.
test('provider rejection reasons are not echoed to the client', async () => {
    const chat = new FakeProvider('chat', 'chat', (query, _opts, provider) =>
        providerEnvelope(provider, query, [hit(provider.id, '1')], [], false));
    const leaky = new FakeProvider('memory-leaky', 'memory', () => {
        throw new Error('SELECT secret FROM /Users/jun/.cli-jaw/creds.db failed: token=abc123');
    });
    const coordinator = new SearchCoordinator(registryOf(chat, leaky));

    const result = await coordinator.search({ query: 'needle', corpus: 'all', limit: 20 });

    const failure = result.warnings.find(warning => warning.provider === 'memory-leaky');
    assert.ok(failure, 'the failure must still be reported');
    assert.equal(failure.code, 'provider_failed');
    assert.equal(failure.message, 'search provider failed');
    assert.doesNotMatch(JSON.stringify(result), /creds\.db|token=abc123|SELECT secret/,
        'no internal detail may reach the response');
});

test('an allowlisted notes engine failure exposes only its canonical warning', async () => {
    const leaky = new FakeProvider('wiki-leaky', 'wiki', () => {
        throw Object.assign(new Error('attacker-controlled /secret token=x'), {
            code: 'notes_search_unavailable',
        });
    });
    const result = await new SearchCoordinator(registryOf(leaky))
        .search({ query: 'needle', corpus: 'wiki' });

    assert.equal(result.warnings[0]?.code, 'notes_search_unavailable');
    assert.equal(result.warnings[0]?.message, 'ripgrep (rg) is not installed');
    assert.doesNotMatch(JSON.stringify(result), /attacker-controlled|\/secret|token=x/);
});

test('an errored provider can expose an allowlisted status reason without keeping pagination open', async () => {
    const broken = new FakeProvider(
        'wiki-broken', 'wiki', () => { throw new Error('must not search'); },
        'error', 'notes_search_unavailable',
    );
    const result = await new SearchCoordinator(registryOf(broken))
        .search({ query: 'needle', corpus: 'wiki' });

    assert.equal(broken.calls.length, 0);
    assert.equal(result.page.hasMore, false);
    assert.equal(result.page.nextCursor, null);
    assert.equal(result.providers[0]?.status, 'error');
    assert.equal(result.warnings[0]?.code, 'notes_search_unavailable');
    assert.equal(result.warnings[0]?.message, 'ripgrep (rg) is not installed');
});
