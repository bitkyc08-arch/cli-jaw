import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CLI_JAW_ELECTRON_HEADER = 'x-cli-jaw-electron';

export function electronRendererToken(): string {
    return process.env['CLI_JAW_ELECTRON_RENDERER_TOKEN'] ?? '';
}

export function isElectronRenderer(req: Request): boolean {
    const expected = electronRendererToken();
    const actual = req.get(CLI_JAW_ELECTRON_HEADER);
    if (!expected || !actual) return false;

    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    if (expectedBytes.length !== actualBytes.length) return false;
    return timingSafeEqual(expectedBytes, actualBytes);
}

export function requireElectronRenderer(req: Request, res: Response, next: NextFunction): void {
    if (isElectronRenderer(req)) {
        next();
        return;
    }
    res.status(403).json({ ok: false, error: 'desktop renderer only' });
}
