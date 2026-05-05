import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { httpStatus, httpCode } from './_http-error.js';
import fs from 'fs';
import { join } from 'path';
import { assertSkillId } from '../security/path-guards.js';
import { SKILLS_DIR, SKILLS_REF_DIR } from '../core/config.js';
import { getMergedSkills, regenerateB } from '../prompt/builder.js';

import type { Request } from 'express';

export type WebCommandCtxFactory = (req: Request) => { resetSkills: (mode: 'hard' | 'soft') => Promise<unknown> };

export function registerSkillRoutes(app: Express, requireAuth: AuthMiddleware, makeWebCommandCtx: WebCommandCtxFactory): void {
    app.get('/api/skills', (req, res) => {
        const lang = (String(req.query.locale || 'ko')).toLowerCase();
        const skills = getMergedSkills().map(s => ({
            ...s,
            name: (s as Record<string, unknown>)[`name_${lang}`] as string || s.name,
            description: (s as Record<string, unknown>)[`desc_${lang}`] as string || s.description,
        }));
        res.json(skills);
    });

    app.post('/api/skills/enable', requireAuth, (req, res) => {
        try {
            const id = assertSkillId(req.body?.id);
            const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
            const dstDir = join(SKILLS_DIR, id);
            const dstPath = join(dstDir, 'SKILL.md');
            if (fs.existsSync(dstPath)) return res.json({ ok: true, msg: 'already enabled' });
            if (!fs.existsSync(refPath)) return res.status(404).json({ error: 'skill not found in ref' });
            fs.cpSync(join(SKILLS_REF_DIR, id), dstDir, { recursive: true });
            regenerateB();
            res.json({ ok: true });
        } catch (e: unknown) {
            res.status(httpStatus(e, 400)).json({ error: (e as Error).message });
        }
    });

    app.post('/api/skills/disable', requireAuth, (req, res) => {
        try {
            const id = assertSkillId(req.body?.id);
            const dstDir = join(SKILLS_DIR, id);
            if (!fs.existsSync(dstDir)) return res.json({ ok: true, msg: 'already disabled' });
            fs.rmSync(dstDir, { recursive: true });
            regenerateB();
            res.json({ ok: true });
        } catch (e: unknown) {
            res.status(httpStatus(e, 400)).json({ error: (e as Error).message });
        }
    });

    app.get('/api/skills/:id', (req, res) => {
        try {
            const id = assertSkillId(req.params.id);
            const activePath = join(SKILLS_DIR, id, 'SKILL.md');
            const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
            const p = fs.existsSync(activePath) ? activePath : refPath;
            if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
            res.type('text/markdown').send(fs.readFileSync(p, 'utf8'));
        } catch (e: unknown) {
            res.status(httpStatus(e, 400)).json({ error: (e as Error).message });
        }
    });

    app.post('/api/skills/reset', requireAuth, async (req, res) => {
        try {
            const mode = (req.query.mode === 'hard') ? 'hard' as const : 'soft' as const;
            const ctx = makeWebCommandCtx(req);
            const result = await ctx.resetSkills(mode);
            res.json({ ok: true, ...(result as Record<string, unknown>) });
        } catch (e: unknown) {
            res.status(500).json({ error: (e as Error).message });
        }
    });
}
