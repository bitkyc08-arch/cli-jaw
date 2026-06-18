// Code mode REST surface (Phase 1 scaffold). Streaming/permission events flow via
// the 'jwc' SSE topic; prompt is accept-then-stream — never a blocking response
// (jawcode 113.2 §4). Design SoT: jawcode devlog 112.3 §S1.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Router, type RequestHandler } from 'express';
import { acpHost } from '../code-mode/acp-host.js';
import { resolveJwcModelOptions } from '../code-mode/model-options.js';

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
        execFile('git', args, { cwd, timeout: 5_000 }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
        });
    });
}

export function registerCodeRoutes(app: Router, requireAuth: RequestHandler): void {
    // Workspace metadata for the picker (112.1 G1/G2).
    app.get('/api/code/git-info', requireAuth, (req, res) => {
        void (async () => {
            const cwd = String(req.query['cwd'] || '');
            if (!cwd || !isAbsolute(cwd)) { res.status(400).json({ ok: false, error: 'absolute cwd required' }); return; }
            const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
            if (!branch) { res.json({ ok: true, isRepo: false, branch: null, worktrees: [] }); return; }
            const head = await git(cwd, ['rev-parse', '--short', 'HEAD']);
            const statusOutput = await git(cwd, ['status', '--short']);
            const statusLines = statusOutput ? statusOutput.split('\n').filter(Boolean) : [];
            const status = {
                dirty: statusLines.length > 0,
                changed: statusLines.filter(line => !line.startsWith('??')).length,
                untracked: statusLines.filter(line => line.startsWith('??')).length,
            };
            const porcelain = await git(cwd, ['worktree', 'list', '--porcelain']);
            const worktrees = porcelain.split('\n\n').filter(Boolean).map(block => {
                const lines = block.split('\n');
                const path = lines.find(l => l.startsWith('worktree '))?.slice(9) ?? '';
                const wtBranch = lines.find(l => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') ?? null;
                const wtHead = lines.find(l => l.startsWith('HEAD '))?.slice(5) ?? null;
                return { path, branch: wtBranch, head: wtHead, current: path === cwd };
            });
            res.json({ ok: true, isRepo: true, branch, head, status, worktrees });
        })();
    });

    app.get('/api/code/models', requireAuth, (_req, res) => {
        void (async () => {
            const options = await resolveJwcModelOptions();
            res.json({ ok: true, ...options });
        })();
    });

    app.get('/api/code/sessions', requireAuth, (_req, res) => {
        res.json({ ok: true, sessions: acpHost.listSessions() });
    });

    app.get('/api/code/sessions/stored', requireAuth, (req, res) => {
        void (async () => {
            const cwd = typeof req.query['cwd'] === 'string' ? req.query['cwd'] : undefined;
            try {
                const sessions = await acpHost.listStoredSessions(cwd);
                res.json({ ok: true, sessions });
            } catch (err: unknown) {
                res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/load', requireAuth, (req, res) => {
        void (async () => {
            const body = req.body as Record<string, unknown> | undefined;
            const sessionId = String(body?.['sessionId'] || '');
            const cwd = String(body?.['cwd'] || '');
            if (!sessionId || !cwd || !isAbsolute(cwd)) { res.status(400).json({ ok: false, error: 'sessionId and absolute cwd required' }); return; }
            try {
                const session = await acpHost.loadSession(sessionId, cwd);
                res.json({ ok: true, session });
            } catch (err: unknown) {
                res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/:id/ext', requireAuth, (req, res) => {
        void (async () => {
            const body = req.body as Record<string, unknown> | undefined;
            const method = String(body?.['method'] || '');
            if (!method) { res.status(400).json({ ok: false, error: 'method required' }); return; }
            try {
                const result = await acpHost.extMethod(String(req.params['id']), method, (body?.['params'] ?? {}) as Record<string, unknown>);
                res.json({ ok: true, result });
            } catch (err: unknown) {
                res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/:id/fork', requireAuth, (req, res) => {
        void (async () => {
            const body = req.body as Record<string, unknown> | undefined;
            const cwd = String(body?.['cwd'] || '');
            if (!cwd || !isAbsolute(cwd)) { res.status(400).json({ ok: false, error: 'absolute cwd required' }); return; }
            try {
                const session = await acpHost.forkSession(String(req.params['id']), cwd);
                res.status(201).json({ ok: true, session });
            } catch (err: unknown) {
                res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/:id/model', requireAuth, (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        const modelId = String(body?.['modelId'] || '');
        if (!modelId) { res.status(400).json({ ok: false, error: 'modelId required' }); return; }
        acpHost.setSessionModel(String(req.params['id']), modelId).then(
            () => res.json({ ok: true }),
            (err: unknown) => res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    app.post('/api/code/sessions', requireAuth, (req, res) => {
        void (async () => {
            const body = req.body as Record<string, unknown> | undefined;
            const cwd = String(body?.['cwd'] || '');
            const model = body?.['model'] ? String(body['model']) : undefined;
            if (!cwd || !isAbsolute(cwd)) { res.status(400).json({ ok: false, error: 'absolute cwd required' }); return; }
            try {
                const session = await acpHost.newSession(cwd, model ? { model } : undefined);
                res.status(201).json({ ok: true, session });
            } catch (err) {
                res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/:id/prompt', requireAuth, (req, res) => {
        void (async () => {
            const body = req.body as Record<string, unknown> | undefined;
            const text = String(body?.['text'] || '').trim();
            if (!text) { res.status(400).json({ ok: false, error: 'text required' }); return; }
            try {
                const accepted = await acpHost.prompt(String(req.params['id']), text);
                res.status(202).json({ ok: true, ...accepted });
            } catch (err) {
                res.status(404).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        })();
    });

    app.post('/api/code/sessions/:id/cancel', requireAuth, (req, res) => {
        acpHost.cancel(String(req.params['id'])).then(
            () => res.json({ ok: true }),
            err => res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    app.post('/api/code/sessions/:id/config', requireAuth, (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        const configId = String(body?.['configId'] || '');
        const valueId = String(body?.['valueId'] || '');
        if (!configId) { res.status(400).json({ ok: false, error: 'configId required' }); return; }
        acpHost.setSessionConfig(String(req.params['id']), configId, valueId).then(
            () => res.json({ ok: true }),
            (err: unknown) => res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    app.delete('/api/code/sessions/:id', requireAuth, (req, res) => {
        acpHost.closeSession(String(req.params['id'])).then(
            () => res.json({ ok: true }),
            err => res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    app.get('/api/code/permissions', requireAuth, (req, res) => {
        const sessionId = req.query['session'] ? String(req.query['session']) : undefined;
        res.json({ ok: true, permissions: acpHost.listPendingPermissions(sessionId) });
    });

    app.post('/api/code/permissions/:id', requireAuth, (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        const optionId = body?.['optionId'] === null || body?.['optionId'] === undefined ? null : String(body['optionId']);
        const answered = acpHost.answerPermission(String(req.params['id']), optionId);
        if (!answered) { res.status(404).json({ ok: false, error: 'unknown permission id' }); return; }
        res.json({ ok: true });
    });
}
