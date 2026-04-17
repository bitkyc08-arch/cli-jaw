import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import crypto from 'crypto';
import { ok } from '../http/response.js';
import { broadcast } from '../core/bus.js';
import { db, getEmployees, insertEmployee, deleteEmployee } from '../core/db.js';
import { regenerateB } from '../prompt/builder.js';
import { getDefaultClaudeModel } from '../cli/claude-models.js';
import { seedDefaultEmployees, listEmployees, findStaticEmployee } from '../core/employees.js';
import { settings, saveSettings } from '../core/config.js';

// Static employee IDs look like `static:control` — routes use this prefix to
// branch between DB CRUD and settings-backed override storage.
const STATIC_ID_PREFIX = 'static:';
function parseStaticId(id: string): string | null {
    return id.startsWith(STATIC_ID_PREFIX) ? id.slice(STATIC_ID_PREFIX.length) : null;
}

export function registerEmployeeRoutes(app: Express, requireAuth: AuthMiddleware): void {
    // Returns merged [static first, then DB]. Static entries carry `id: static:<name>`
    // so the frontend can round-trip edits through PUT.
    app.get('/api/employees', (_, res) => ok(res, listEmployees()));

    app.post('/api/employees', requireAuth, (req, res) => {
        const id = crypto.randomUUID();
        const { name = 'New Agent', cli = 'claude', model = 'default', role = '' } = req.body || {};
        const nextModel = cli === 'claude' && (!model || model === 'default')
            ? getDefaultClaudeModel()
            : model;
        insertEmployee.run(id, name, cli, nextModel, role);
        const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Record<string, any>;
        broadcast('agent_added', emp);
        regenerateB();
        res.json(emp);
    });

    app.put('/api/employees/:id', requireAuth, (req, res) => {
        const updates = req.body || {};
        const staticSlug = parseStaticId(String(req.params.id));

        // Static employees: only `model` is mutable; CLI and name are locked to the
        // registry definition. Overrides persist in settings.staticEmployees[Name].
        if (staticSlug) {
            const spec = findStaticEmployee(staticSlug);
            if (!spec) return res.status(404).json({ error: 'unknown static employee' });
            const newModel = typeof updates.model === 'string' ? updates.model : null;
            if (!newModel) {
                return res.status(400).json({ error: 'static employees only allow model updates' });
            }
            const overrides = (settings.staticEmployees as Record<string, { model?: string }>) || {};
            overrides[spec.name] = { ...overrides[spec.name], model: newModel };
            settings.staticEmployees = overrides;
            saveSettings(settings);
            const merged = listEmployees().find(e => e.id === req.params.id);
            if (merged) broadcast('agent_updated', merged as Record<string, any>);
            regenerateB();
            return res.json(merged);
        }

        const allowed = ['name', 'cli', 'model', 'role', 'status'];
        const sets = Object.keys(updates).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
        if (sets.length === 0) return res.status(400).json({ error: 'no valid fields' });
        const vals = sets.map((_, i) => (updates as Record<string, any>)[Object.keys(updates).filter(k => allowed.includes(k))[i]!]);
        db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
        const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id) as Record<string, any>;
        broadcast('agent_updated', emp);
        regenerateB();
        res.json(emp);
    });

    app.delete('/api/employees/:id', requireAuth, (req, res) => {
        // Static employees cannot be deleted (they're baked into the binary) —
        // reject explicitly so the frontend can show the correct UX.
        if (parseStaticId(String(req.params.id))) {
            return res.status(400).json({ error: 'static employees cannot be deleted' });
        }
        deleteEmployee.run(req.params.id);
        broadcast('agent_deleted', { id: req.params.id });
        regenerateB();
        res.json({ ok: true });
    });

    // Employee reset — delete all + re-seed 5 defaults
    app.post('/api/employees/reset', requireAuth, (req, res) => {
        const { seeded } = seedDefaultEmployees({ reset: true, notify: true });
        res.json({ ok: true, seeded });
    });
}
