// ─── Request locale resolution (web surface) ─────────
// Extracted from server.ts in Phase 2.
// Priority: explicit override > body.locale > ?locale= > Accept-Language > settings.

import type { Request } from 'express';
import { settings } from '../core/config.js';
import { normalizeLocale } from '../core/i18n.js';

export function resolveRequestLocale(req: Request | null, preferred: string | null = null): string {
    const fallback = settings["locale"] || 'ko';
    const direct = typeof preferred === 'string' ? preferred.trim() : '';
    if (direct) return normalizeLocale(direct, fallback);

    const bodyLocale = typeof req?.body?.locale === 'string' ? req.body.locale.trim() : '';
    if (bodyLocale) return normalizeLocale(bodyLocale, fallback);

    const queryLocale = typeof req?.query?.["locale"] === 'string' ? req.query["locale"].trim() : '';
    if (queryLocale) return normalizeLocale(queryLocale, fallback);

    const acceptLanguage = typeof req?.headers?.['accept-language'] === 'string'
        ? req.headers['accept-language']
        : '';
    if (acceptLanguage) {
        const primary = acceptLanguage.split(',')[0]?.trim() || '';
        if (primary) return normalizeLocale(primary, fallback);
    }

    return normalizeLocale(fallback, 'ko');
}
