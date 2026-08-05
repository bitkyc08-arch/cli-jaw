// ─── Wiki control routes (devlog 040 §7) ──────────────
// Status is readable, enabling scaffolds. Both sit behind the same auth boundary as
// every other mutating core route: this one writes directories to a path the caller
// chooses, so it cannot be less protected than a settings change.

import type { Express, RequestHandler } from 'express';
import { ok, fail } from '../http/response.js';
import {
    assertUsableWikiRoot,
    normalizeWikiConfig,
    readUsableWikiConfig,
    readWikiConfig,
    wikiProviderStatus,
    writeWikiConfig,
    type WikiConfig,
} from '../wiki/config.js';
import { scaffoldWikiVault } from '../wiki/scaffold.js';

export type WikiRouteDeps = {
    // Injected so core keeps no dependency on manager configuration. These are the
    // roots the vault must not collide with (040 §0c R2).
    forbiddenRoots?: () => readonly string[];
    scaffold?: typeof scaffoldWikiVault;
};

function statusPayload(config: WikiConfig) {
    return {
        enabled: config.enabled,
        root: config.root,
        promptDigest: config.promptDigest,
        provider: wikiProviderStatus(config),
    };
}

export function registerWikiRoutes(
    app: Express,
    requireAuth: RequestHandler,
    deps: WikiRouteDeps = {},
): void {
    const forbiddenRoots = deps.forbiddenRoots ?? (() => []);
    const scaffold = deps.scaffold ?? scaffoldWikiVault;

    app.get('/api/wiki/status', requireAuth, (_req, res) => {
        try {
            // The validated view, for the same reason the provider and the prompt use it:
            // the settings API can write this block without passing through enable, and
            // status must not report a forbidden root as ready or probe underneath it.
            ok(res, statusPayload(readUsableWikiConfig(forbiddenRoots())));
        } catch (error) {
            // An unusable persisted root should still produce a readable status rather
            // than a 500 the user cannot act on.
            ok(res, {
                enabled: false, root: null, promptDigest: false, provider: 'error',
                reason: (error as Error).message,
            });
        }
    });

    app.post('/api/wiki/enable', requireAuth, async (req, res) => {
        let candidate: WikiConfig;
        try {
            const current = readWikiConfig();
            const rawRoot = typeof req.body?.root === 'string' ? req.body.root : current.root;
            candidate = normalizeWikiConfig({ ...current, root: rawRoot, enabled: true });
            assertUsableWikiRoot(candidate.root, forbiddenRoots());
        } catch (error) {
            // A bad root is the caller's mistake, not an internal failure.
            fail(res, 400, (error as Error).message);
            return;
        }

        try {
            // The setting is written only after the vault is genuinely usable. A failed
            // scaffold therefore leaves the instance disabled, and whatever partial
            // layout it created is left alone rather than deleted: telling a user's own
            // files apart from ours is not something this can do safely.
            await scaffold(candidate.root);
            // Re-normalise after the scaffold: the root did not exist a moment ago, so it
            // could not be pinned to its canonical form then. Persisting the alias instead
            // would leave the setting following a link wherever it is later retargeted.
            const settled = normalizeWikiConfig(candidate);
            const provider = wikiProviderStatus(settled);
            if (provider !== 'ready') throw new Error(`wiki provider is ${provider}`);
            const persisted = await writeWikiConfig(settled);
            ok(res, statusPayload(persisted));
        } catch (error) {
            fail(res, 500, 'wiki_enable_failed', { reason: (error as Error).message });
        }
    });

    app.post('/api/wiki/configure', requireAuth, async (req, res) => {
        let next: WikiConfig;
        try {
            const patch = {
                ...(typeof req.body?.root === 'string' ? { root: req.body.root } : {}),
                ...(typeof req.body?.enabled === 'boolean' ? { enabled: req.body.enabled } : {}),
                ...(typeof req.body?.promptDigest === 'boolean' ? { promptDigest: req.body.promptDigest } : {}),
            };
            next = normalizeWikiConfig({ ...readWikiConfig(), ...patch });
            if (next.enabled) assertUsableWikiRoot(next.root, forbiddenRoots());
        } catch (error) {
            fail(res, 400, (error as Error).message);
            return;
        }

        try {
            if (next.enabled) {
                await scaffold(next.root);
            }
            // Same reason as enable: pin only once the directory exists.
            const settled = next.enabled ? normalizeWikiConfig(next) : next;
            if (settled.enabled) {
                const provider = wikiProviderStatus(settled);
                if (provider !== 'ready') throw new Error(`wiki provider is ${provider}`);
            }
            // Disabling never touches the vault. The files and their history stay; the
            // provider simply stops answering. Deleting data is not a rollback.
            const persisted = await writeWikiConfig(settled);
            ok(res, statusPayload(persisted));
        } catch (error) {
            fail(res, 500, 'wiki_configure_failed', { reason: (error as Error).message });
        }
    });
}
