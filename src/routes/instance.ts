// ─── Instance lock/unlock (process protection) ───────
// Extracted from server.ts in Phase 2.
// Marker file is written by the dashboard manager; these routes only
// toggle the `protected` flag on an existing marker.

import type { Router } from 'express';
import fs from 'fs';
import { join } from 'path';
import { JAW_HOME } from '../core/config.js';

const LOCK_MARKER_FILENAME = '.dashboard-managed.json';

export function registerInstanceRoutes(app: Router): void {
    app.get('/api/instance/lock', (_req, res) => {
        const markerPath = join(JAW_HOME, LOCK_MARKER_FILENAME);
        try {
            if (fs.existsSync(markerPath)) {
                const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                res.json({ ok: true, protected: !!marker.protected, marker });
            } else {
                res.json({ ok: true, protected: false, marker: null });
            }
        } catch { res.json({ ok: true, protected: false, marker: null }); }
    });

    app.post('/api/instance/lock', (_req, res) => {
        const markerPath = join(JAW_HOME, LOCK_MARKER_FILENAME);
        try {
            if (fs.existsSync(markerPath)) {
                const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                marker.protected = true;
                fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
                res.json({ ok: true, protected: true });
            } else {
                res.json({ ok: false, error: 'No marker file — instance is not dashboard-managed.' });
            }
        } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
    });

    app.delete('/api/instance/lock', (_req, res) => {
        const markerPath = join(JAW_HOME, LOCK_MARKER_FILENAME);
        try {
            if (fs.existsSync(markerPath)) {
                const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                delete marker.protected;
                fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
                res.json({ ok: true, protected: false });
            } else {
                res.json({ ok: true, protected: false });
            }
        } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
    });
}
