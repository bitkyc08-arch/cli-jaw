// ─── System info routes (health/session/runtime/token) ─
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.2).
// jawAuthToken is a runtime secret generated at server start — it cannot be
// re-derived here, so it arrives as a factory dep.

import type { Router } from 'express';
import { fail, ok } from '../http/response.js';
import { APP_VERSION, settings } from '../core/config.js';
import { drainLogRing } from '../core/logger.js';
import { getSession } from '../core/db.js';
import { buildChannelHealthSnapshot } from '../messaging/channel-health.js';
import { getCliModelAndEffort } from '../core/main-session.js';
import { isAgentBusy, messageQueue } from '../agent/spawn.js';
import {
    createSlackAppManifest,
    DEFAULT_SLACK_APP_NAME,
    slackManifestJson,
    slackManifestYaml,
} from '../slack/manifest.js';

function getRuntimeSnapshot() {
    const cli = settings["cli"] || null;
    const model = cli ? getCliModelAndEffort(cli, settings).model : 'default';

    return {
        uptimeSec: Math.floor(process.uptime()),
        activeAgent: isAgentBusy(null),
        queuePending: messageQueue.length,
        cli,
        model,
    };
}

export function registerSystemRoutes(app: Router, deps: { jawAuthToken: string }): void {
    app.get('/api/health', (_req, res) => res.json({
        ok: true,
        version: APP_VERSION,
        uptime: process.uptime(),
        channels: buildChannelHealthSnapshot(),
    }));

    // Canonical Slack app manifest for the settings-page copy button. No
    // secrets — scopes and event names only, same exposure class as
    // /api/health, so it stays unauthenticated like its neighbors.
    app.get('/api/slack/manifest', (req, res) => {
        const rawName = req.query['name'];
        if (rawName !== undefined && typeof rawName !== 'string') {
            fail(res, 400, 'invalid_slack_app_name');
            return;
        }
        const appName = rawName ?? DEFAULT_SLACK_APP_NAME;
        try {
            const manifest = createSlackAppManifest(appName);
            ok(res, {
                yaml: slackManifestYaml(appName),
                json: slackManifestJson(appName),
                // Additive field for UI disclosure; existing consumers only
                // read yaml/json. Derive once in the canonical core owner.
                botDisplayName: manifest.features.bot_user.display_name,
            });
        } catch (error) {
            if (error instanceof RangeError) {
                fail(res, 400, 'invalid_slack_app_name');
                return;
            }
            throw error;
        }
    });

    app.get('/api/session', (_, res) => ok(res, getSession(), getSession() as Record<string, unknown> | undefined));

    // Memory composition probe (devlog 260613 docs 07/50 5c): splits the JS
    // heap from native/mmap so RSS investigations can tell "V8 objects" apart
    // from "sqlite-mapped pages + native addons" without a debugger attach.
    app.get('/api/debug/mem', (_req, res) => {
        const m = process.memoryUsage();
        const mb = (n: number) => Math.round(n / 1024 / 1024);
        res.json({
            ok: true,
            rss_mb: mb(m.rss),
            heapTotal_mb: mb(m.heapTotal),
            heapUsed_mb: mb(m.heapUsed),
            external_mb: mb(m.external),
            arrayBuffers_mb: mb(m.arrayBuffers),
            // rough native/mmap share: better-sqlite3 mapped pages, addon code
            native_mmap_mb: mb(Math.max(0, m.rss - m.heapTotal - m.external)),
            uptimeSec: Math.floor(process.uptime()),
        });
    });

    app.get('/api/runtime', (req, res) => {
        if (req.query["logs"] === 'tail') {
            const lines = drainLogRing();
            res.json({ ok: true, lines });
            return;
        }
        ok(res, getRuntimeSnapshot(), getRuntimeSnapshot());
    });

    // Auth token endpoint — Sec-Fetch-Site guard blocks cross-origin XSS token theft
    // Browser-enforced header: cannot be set/spoofed by JS, absent from CLI/curl (passes through)
    app.get('/api/auth/token', (req, res) => {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') {
            res.status(403).json({ error: 'cross-origin token request blocked' });
            return;
        }
        res.json({ token: deps.jawAuthToken });
    });
}
