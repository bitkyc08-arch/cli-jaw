export interface DetailFindRequest { text: string; query: string; generation: number }
export interface DetailFindMatch { line: number; start: number; end: number }
export interface DetailFindResult { generation: number; matches: DetailFindMatch[] }

export function findDetailMatches({ text, query, generation }: DetailFindRequest): DetailFindResult {
    if (!query) return { generation, matches: [] };
    const matches: DetailFindMatch[] = [];
    const haystack = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        let line = 1;
        for (let index = 0; index < start; index += 1) if (text.charCodeAt(index) === 10) line += 1;
        matches.push({ line, start, end: start + query.length });
        from = start + Math.max(1, needle.length);
    }
    return { generation, matches };
}

const workerScope = globalThis as typeof globalThis & { postMessage?: (value: DetailFindResult) => void; onmessage?: (event: MessageEvent<DetailFindRequest>) => void };
if (typeof document === 'undefined' && typeof workerScope.postMessage === 'function') {
    workerScope.onmessage = event => workerScope.postMessage?.(findDetailMatches(event.data));
}
