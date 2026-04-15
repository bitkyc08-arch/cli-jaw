import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import fs from 'fs';
import path from 'path';
import { basename, extname } from 'path';
import express from 'express';
import { ok, fail } from '../http/response.js';
import { saveUpload } from '../agent/spawn.js';
import { settings, saveSettings, UPLOADS_DIR } from '../core/config.js';
import { safeResolveUnder } from '../security/path-guards.js';
import { decodeFilenameSafe } from '../security/decode.js';

type AvatarTarget = 'agent' | 'user';
type AvatarEntry = {
    imagePath: string;
    updatedAt: number | null;
};

const AVATAR_TARGETS = new Set<AvatarTarget>(['agent', 'user']);
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function isAvatarTarget(value: string): value is AvatarTarget {
    return AVATAR_TARGETS.has(value as AvatarTarget);
}

function ensureAvatarSettings(): Record<AvatarTarget, AvatarEntry> {
    const current = settings.avatar || {};
    const next = {
        agent: {
            imagePath: String(current.agent?.imagePath || ''),
            updatedAt: current.agent?.updatedAt == null ? null : Number(current.agent.updatedAt),
        },
        user: {
            imagePath: String(current.user?.imagePath || ''),
            updatedAt: current.user?.updatedAt == null ? null : Number(current.user.updatedAt),
        },
    };
    settings.avatar = next;
    return next;
}

function serializeAvatar(target: AvatarTarget) {
    const avatar = ensureAvatarSettings()[target];
    if (!avatar.imagePath) {
        return { target, kind: 'emoji', updatedAt: avatar.updatedAt };
    }
    return {
        target,
        kind: 'image',
        imageUrl: `/api/avatar/${target}/image?v=${avatar.updatedAt || Date.now()}`,
        updatedAt: avatar.updatedAt,
    };
}

function parseTarget(raw: string): AvatarTarget | null {
    return isAvatarTarget(raw) ? raw : null;
}

function validateUpload(contentType: string, filename: string, body: unknown): void {
    // Accept image/* or octet-stream (browser may not send correct type)
    if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        throw Object.assign(new Error('invalid_image_type'), { statusCode: 400 });
    }
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw Object.assign(new Error('invalid_image_extension'), { statusCode: 400 });
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
        throw Object.assign(new Error('image_required'), { statusCode: 400 });
    }
}

function saveAvatarImage(target: AvatarTarget, imagePath: string): void {
    const avatar = ensureAvatarSettings();
    avatar[target] = {
        imagePath,
        updatedAt: Date.now(),
    };
    saveSettings(settings);
}

function resetAvatarImage(target: AvatarTarget): void {
    const avatar = ensureAvatarSettings();
    avatar[target] = {
        imagePath: '',
        updatedAt: Date.now(),
    };
    saveSettings(settings);
}

function resolveAvatarImage(target: AvatarTarget): string | null {
    const avatar = ensureAvatarSettings()[target];
    if (!avatar.imagePath) return null;
    const safePath = safeResolveUnder(UPLOADS_DIR, basename(avatar.imagePath));
    return fs.existsSync(safePath) ? safePath : null;
}

export function registerAvatarRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/avatar', (_req, res) => {
        ok(res, {
            agent: serializeAvatar('agent'),
            user: serializeAvatar('user'),
        });
    });

    app.post('/api/avatar/:target/upload', requireAuth, express.raw({ type: ['image/*', 'application/octet-stream'], limit: '5mb' }), (req, res) => {
        const target = parseTarget(String(req.params.target || ''));
        if (!target) return fail(res, 400, 'invalid_avatar_target');

        try {
            const contentType = String(req.headers['content-type'] || '').toLowerCase();
            const filename = decodeFilenameSafe(req.headers['x-filename'] as string | undefined) || `${target}.png`;
            const bodyLen = Buffer.isBuffer(req.body) ? req.body.length : 0;
            console.log(`[avatar:upload] target=${target} ct=${contentType} file=${filename} bodyLen=${bodyLen}`);
            validateUpload(contentType, filename, req.body);
            const filePath = saveUpload(req.body, filename);
            saveAvatarImage(target, filePath);
            return ok(res, serializeAvatar(target));
        } catch (error: unknown) {
            console.error('[avatar:upload] failed:', error instanceof Error ? error.message : error);
            const status = (error as { statusCode?: number })?.statusCode || 400;
            return fail(res, status, error instanceof Error ? error.message : 'avatar_upload_failed');
        }
    });

    app.delete('/api/avatar/:target/image', requireAuth, (req, res) => {
        const target = parseTarget(String(req.params.target || ''));
        if (!target) return fail(res, 400, 'invalid_avatar_target');
        resetAvatarImage(target);
        return ok(res, serializeAvatar(target));
    });

    app.get('/api/avatar/:target/image', (req, res) => {
        const target = parseTarget(String(req.params.target || ''));
        console.log(`[avatar:image] GET target=${target} params=${JSON.stringify(req.params)}`);
        if (!target) return fail(res, 400, 'invalid_avatar_target');

        const imagePath = resolveAvatarImage(target);
        if (!imagePath) return fail(res, 404, 'avatar_image_not_found');

        res.setHeader('Cache-Control', 'no-store');
        // Express 5: sendFile with absolute path needs root option
        return res.sendFile(basename(imagePath), { root: path.dirname(imagePath) });
    });
}
