import { findDetailMatches, type DetailFindMatch } from './detail-find.worker.ts';

export interface ToolSearchHit { turnId: string; turnSeq: number; detailRef: unknown; line?: number; byteStart?: number; byteEnd?: number; snippet: string }
export interface ToolSearchResponse { hits: ToolSearchHit[] }
export type SearchFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let serverCapability: boolean | undefined;

export function resetToolSearchCapability(): void { serverCapability = undefined; }
export async function searchToolOutput(query: string, residentText: string, fetcher: SearchFetcher = fetch): Promise<{ mode: 'server'; hits: ToolSearchHit[] } | { mode: 'resident'; hits: DetailFindMatch[] }> {
    if (serverCapability !== false) {
        const response = await fetcher(`/api/chat/search?q=${encodeURIComponent(query)}&scope=tools`);
        if (response.status === 404) serverCapability = false;
        else if (response.ok) { serverCapability = true; return { mode: 'server', hits: ((await response.json()) as ToolSearchResponse).hits }; }
        else throw new Error(`Tool search failed (${response.status})`);
    }
    return { mode: 'resident', hits: findDetailMatches({ text: residentText, query, generation: 0 }).matches };
}

export interface HitNavigation { hydrate(hit: ToolSearchHit): Promise<void>; scroll(hit: ToolSearchHit): Promise<void>; focus(hit: ToolSearchHit): void; expand(hit: ToolSearchHit): Promise<void>; seek(hit: ToolSearchHit): Promise<void> }
export async function navigateToToolHit(hit: ToolSearchHit, actions: HitNavigation): Promise<void> {
    await actions.hydrate(hit); await actions.scroll(hit); actions.focus(hit); await actions.expand(hit); await actions.seek(hit);
}
