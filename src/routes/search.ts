import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { getMessageContext } from '../core/db.js';
import type { SearchCorpus, SearchHit, SearchQuery, SearchResultEnvelope } from '../search/contract.js';
import type { SearchCoordinator } from '../search/coordinator.js';

const CORPORA = new Set<SearchCorpus>(['chat', 'memory', 'wiki', 'all']);
const invalidQuery = (message: string): Error & { statusCode: number; code: string } =>
    Object.assign(new Error(message), { statusCode: 400, code: 'invalid_query' });
const optionalString = (value: unknown): string | undefined => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || undefined;
};

function parseCorpus(value: unknown): SearchCorpus {
    const corpus = String(value ?? 'all');
    if (!CORPORA.has(corpus as SearchCorpus)) throw invalidQuery('invalid corpus');
    return corpus as SearchCorpus;
}

function parseIntegerInRange(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidQuery(`invalid ${name}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw invalidQuery(`invalid ${name}`);
    }
    return parsed;
}

const optionalPositive = (value: unknown): number | undefined => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

function addContext(hit: SearchHit, range: number): SearchHit {
    if (hit.corpus !== 'chat' || !hit.session) return hit;
    const id = Number(hit.key);
    if (!Number.isInteger(id)) return hit;
    const context = getMessageContext.all({ session_id: hit.session, target_id: id, range });
    return { ...hit, metadata: { ...hit.metadata, context } };
}

export function registerSearchRoutes(
    app: Router,
    requireAuth: RequestHandler,
    coordinator: SearchCoordinator,
): void {
    app.get('/api/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
        try {
            const corpus = parseCorpus(req.query['corpus']);
            const sessionFilter = optionalString(req.query['sessionFilter']);
            const limit = parseIntegerInRange(req.query['limit'], 'limit', 1, 100);
            const contextValue = parseIntegerInRange(req.query['context'], 'context', 0, 5);
            const context = contextValue === 0 ? undefined : contextValue;
            const cursor = optionalString(req.query['cursor']);
            const days = optionalPositive(req.query['days']);
            const recent = optionalPositive(req.query['recent']);
            const query: SearchQuery = {
                query: String(req.query['q'] ?? ''),
                corpus,
                ...(sessionFilter !== undefined ? { sessionFilter } : {}),
                ...(limit !== undefined ? { limit } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
                ...(days !== undefined ? { days } : {}),
                ...(recent !== undefined ? { recent } : {}),
                ...(context !== undefined ? { context } : {}),
            };
            let body: SearchResultEnvelope = await coordinator.search(query);
            if (context !== undefined) {
                body = {
                    ...body,
                    groups: body.groups.map(group => ({
                        ...group,
                        hits: group.hits.map(hit => addContext(hit, context)),
                    })),
                };
            }
            res.json(body);
        } catch (error) {
            const typed = error as { statusCode?: number; code?: string; message?: string };
            if (typed.statusCode === 400) {
                const code = typed.code === 'invalid_cursor' ? 'invalid_cursor' : 'invalid_query';
                res.status(400).json({ code, error: typed.message ?? code });
                return;
            }
            next(error);
        }
    });
}
