import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWikiRoutes } from '../../src/routes/wiki.ts';
import { DEFAULT_WIKI_CONFIG, normalizeWikiConfig, readWikiConfig, writeWikiConfig } from '../../src/wiki/config.ts';

function tempRoot(): string {
    return join(mkdtempSync(join(tmpdir(), 'jaw-wiki-route-')), 'vault');
}

type ServerOptions = {
    auth?: (req: Request, res: Response, next: NextFunction) => void;
    forbiddenRoots?: readonly string[];
    scaffold?: (root: string) => Promise<void>;
};

async function withServer(fn: (baseUrl: string) => Promise<void>, options: ServerOptions = {}): Promise<void> {
    const app = express();
    app.use(express.json());
    const auth = options.auth ?? ((_q: Request, _s: Response, next: NextFunction) => next());
    registerWikiRoutes(app, auth, {
        forbiddenRoots: () => options.forbiddenRoots ?? [],
        ...(options.scaffold ? { scaffold: options.scaffold } : {}),
    });
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

const post = (baseUrl: string, path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

afterEach(async () => {
    await writeWikiConfig(normalizeWikiConfig(DEFAULT_WIKI_CONFIG));
});

// 040 §12 criterion 1 — a disabled instance reports off and reads nothing into being.
// The root is pinned to a path this test owns rather than the default, because other
// tests in the suite share a home directory and may have created the default vault.
test('status reports a disabled vault and creates nothing', async () => {
    const root = tempRoot();
    await writeWikiConfig(normalizeWikiConfig({ ...DEFAULT_WIKI_CONFIG, root }));

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/api/wiki/status`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.enabled, false);
        assert.equal(body.data.provider, 'off');
        assert.equal(body.data.root, root);
    });
    assert.equal(existsSync(root), false, 'reading the status must not create the vault');
});

// This route writes directories to a caller-chosen path, so it cannot be less protected
// than an ordinary settings change.
test('every wiki route sits behind the auth boundary', async () => {
    const denied = (_q: Request, res: Response) => { res.status(401).json({ error: 'Unauthorized' }); };
    await withServer(async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/wiki/status`)).status, 401);
        assert.equal((await post(baseUrl, '/api/wiki/enable', {})).status, 401);
        assert.equal((await post(baseUrl, '/api/wiki/configure', { enabled: false })).status, 401);
    }, { auth: denied });
});

test('enabling scaffolds the vault and turns the provider ready', async () => {
    const root = tempRoot();
    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/wiki/enable', { root });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.data.enabled, true);
        assert.equal(body.data.provider, 'ready');
    });
    assert.equal(readWikiConfig().enabled, true, 'the setting persisted');
    assert.ok(existsSync(join(root, 'syntheses/compiled-digest.md')));
});

// 040 §0c R2 — pointing the vault at the notes root would scatter scaffold files
// through the user's notes.
test('a root colliding with the notes vault is refused before anything is written', async () => {
    const notes = tempRoot();
    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/wiki/enable', { root: notes });
        assert.equal(response.status, 400, 'a caller mistake, not an internal failure');
        assert.match((await response.json()).error, /collides/);
    }, { forbiddenRoots: [notes] });
    assert.equal(existsSync(notes), false, 'and nothing was scaffolded');
    assert.equal(readWikiConfig().enabled, false);
});

test('an unusable root is a 400 rather than a 500', async () => {
    await withServer(async baseUrl => {
        for (const root of ['', 'relative/path', '.']) {
            const response = await post(baseUrl, '/api/wiki/enable', { root });
            assert.equal(response.status, 400, `${root || '(empty)'} must be rejected as input`);
        }
    });
});

// 040 §12 criterion 2 — a failed scaffold leaves the instance disabled.
test('a failed scaffold reports the failure and leaves the vault disabled', async () => {
    const root = tempRoot();
    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/wiki/enable', { root });
        assert.equal(response.status, 500);
        assert.equal((await response.json()).error, 'wiki_enable_failed');
    }, { scaffold: async () => { throw new Error('EACCES: permission denied'); } });

    assert.equal(readWikiConfig().enabled, false, 'the setting must not have been written');
});

// Disabling is not a delete. The vault and its history stay; the provider stops.
test('disabling keeps the vault on disk', async () => {
    const root = tempRoot();
    await withServer(async baseUrl => {
        assert.equal((await post(baseUrl, '/api/wiki/enable', { root })).status, 200);
        const response = await post(baseUrl, '/api/wiki/configure', { enabled: false });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.enabled, false);
        assert.equal(body.data.provider, 'off');
    });
    assert.ok(existsSync(join(root, 'WIKI.md')), 'the files survive being disabled');
});

test('the digest flag can be set without touching the other fields', async () => {
    const root = tempRoot();
    await withServer(async baseUrl => {
        assert.equal((await post(baseUrl, '/api/wiki/enable', { root })).status, 200);
        const response = await post(baseUrl, '/api/wiki/configure', { promptDigest: true });
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
    });

    const config = readWikiConfig();
    assert.equal(config.promptDigest, true);
    assert.equal(config.enabled, true, 'a partial patch must not clear the other flags');
    // The persisted root is canonical, which on macOS resolves /var to /private/var.
    const { realpathSync } = await import('node:fs');
    assert.equal(config.root, realpathSync(root), 'nor the root');
});

// The root does not exist when it is first validated, so it cannot be pinned to its
// canonical form then. Persisting the alias instead would leave the setting following a
// link wherever it is later retargeted.
test('enabling through a symlinked path persists the canonical root', async () => {
    const { mkdirSync, symlinkSync, realpathSync } = await import('node:fs');
    const base = mkdtempSync(join(tmpdir(), 'jaw-wiki-alias-'));
    const real = join(base, 'real');
    mkdirSync(real);
    const alias = join(base, 'alias');
    symlinkSync(real, alias);

    await withServer(async baseUrl => {
        const response = await post(baseUrl, '/api/wiki/enable', { root: join(alias, 'vault') });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.data.root, join(realpathSync(real), 'vault'), 'the alias is resolved away');
    });

    assert.equal(readWikiConfig().root, join(realpathSync(real), 'vault'));
});
