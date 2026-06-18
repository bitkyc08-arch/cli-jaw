import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';

const acpHostCalls: Array<{ scope?: string; cwd?: string }> = [];
const acpHostPath = resolve(import.meta.dirname, '../../src/code-mode/acp-host.js');

mock.module(acpHostPath, {
	namedExports: {
		acpHost: {
			listSessions: () => [],
			listPendingPermissions: () => [],
			listStoredSessions: async (options: { scope?: 'all' | 'cwd'; cwd?: string } = {}) => {
				acpHostCalls.push(options);
				return [{
					sessionId: `stored-${options.scope ?? 'all'}`,
					cwd: options.cwd ?? '/global',
					title: 'Stored route fixture',
				}];
			},
			loadSession: async () => { throw new Error('not used'); },
			extMethod: async () => ({}),
			forkSession: async () => { throw new Error('not used'); },
			newSession: async () => { throw new Error('not used'); },
			setSessionModel: async () => {},
			prompt: async () => ({ accepted: true, sessionId: 'unused' }),
			cancel: async () => {},
			setSessionConfig: async () => {},
			closeSession: async () => {},
			answerPermission: () => false,
		},
	},
});

const { registerCodeRoutes } = await import('../../src/routes/code.ts');

const noAuth = (_req: Request, _res: Response, next: NextFunction) => next();

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
	const app = express();
	app.use(express.json());
	registerCodeRoutes(app, noAuth);
	const server = app.listen(0);
	try {
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		await fn(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

test('code routes expose read-only session and permission surfaces without starting jwc', async () => {
	await withServer(async baseUrl => {
		const sessions = await fetch(`${baseUrl}/api/code/sessions`);
		assert.equal(sessions.status, 200);
		assert.deepEqual(await sessions.json(), { ok: true, sessions: [] });

		const permissions = await fetch(`${baseUrl}/api/code/permissions`);
		assert.equal(permissions.status, 200);
		assert.deepEqual(await permissions.json(), { ok: true, permissions: [] });
	});
});

test('code stored sessions route defaults to global catalog and validates cwd scope', async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), 'cli-jaw-code-routes-cwd-'));
	try {
		await withServer(async baseUrl => {
			acpHostCalls.length = 0;
			const missingScope = await fetch(`${baseUrl}/api/code/sessions/stored`);
			assert.equal(missingScope.status, 200);
			assert.deepEqual(acpHostCalls.at(-1), { scope: 'all' });
			assert.equal(((await missingScope.json()) as { sessions: unknown[] }).sessions.length, 1);

			const allScope = await fetch(`${baseUrl}/api/code/sessions/stored?scope=all`);
			assert.equal(allScope.status, 200);
			assert.deepEqual(acpHostCalls.at(-1), { scope: 'all' });

			const missingCwd = await fetch(`${baseUrl}/api/code/sessions/stored?scope=cwd`);
			assert.equal(missingCwd.status, 400);
			assert.deepEqual(await missingCwd.json(), { ok: false, error: 'absolute cwd required for cwd scope' });

			const relativeCwd = await fetch(`${baseUrl}/api/code/sessions/stored?scope=cwd&cwd=relative`);
			assert.equal(relativeCwd.status, 400);
			assert.deepEqual(await relativeCwd.json(), { ok: false, error: 'absolute cwd required for cwd scope' });

			const absoluteCwd = await fetch(`${baseUrl}/api/code/sessions/stored?scope=cwd&cwd=${encodeURIComponent(cwd)}`);
			assert.equal(absoluteCwd.status, 200);
			assert.deepEqual(acpHostCalls.at(-1), { scope: 'cwd', cwd });
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test('code git-info rejects missing cwd and reports non-repo absolute cwd', async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), 'cli-jaw-code-routes-'));
	try {
		await withServer(async baseUrl => {
			const missing = await fetch(`${baseUrl}/api/code/git-info`);
			assert.equal(missing.status, 400);
			assert.deepEqual(await missing.json(), { ok: false, error: 'absolute cwd required' });

			const nonRepo = await fetch(`${baseUrl}/api/code/git-info?cwd=${encodeURIComponent(cwd)}`);
			assert.equal(nonRepo.status, 200);
			assert.deepEqual(await nonRepo.json(), { ok: true, isRepo: false, branch: null, worktrees: [] });
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test('code git-info reports repo root and current worktree context for nested cwd', async () => {
	const repo = mkdtempSync(path.join(tmpdir(), 'cli-jaw-code-routes-repo-'));
	const nested = path.join(repo, 'packages', 'app');
	try {
		execFileSync('mkdir', ['-p', nested]);
		execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
		execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
		execFileSync('sh', ['-lc', 'echo ok > README.md && git add README.md && git commit -m init >/dev/null'], { cwd: repo });
		const realRepo = realpathSync(repo);
		await withServer(async baseUrl => {
			const response = await fetch(`${baseUrl}/api/code/git-info?cwd=${encodeURIComponent(nested)}`);
			assert.equal(response.status, 200);
			const json = await response.json() as {
				ok: boolean;
				isRepo: boolean;
				repoRoot?: string;
				relativePath?: string;
				currentWorktree?: { path: string; branch: string | null };
				worktrees: Array<{ path: string; current?: boolean }>;
			};
			assert.equal(json.ok, true);
			assert.equal(json.isRepo, true);
			assert.equal(json.repoRoot, realRepo);
			assert.equal(json.relativePath, 'packages/app');
			assert.equal(json.currentWorktree?.path, realRepo);
			assert.equal(json.worktrees.some(worktree => worktree.path === realRepo && worktree.current), true);
		});
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
