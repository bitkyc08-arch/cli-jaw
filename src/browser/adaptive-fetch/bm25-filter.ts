interface BM25Options {
    query: string;
    topK?: number;
    minScore?: number;
}

const DEFAULT_TOP_K = 15;
const DEFAULT_MIN_SCORE = 0.1;
const K1 = 1.5;
const B = 0.75;

export function bm25Filter(text: string, options: BM25Options): string {
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length <= (options.topK || DEFAULT_TOP_K)) return text;

    const queryTerms = tokenize(options.query);
    if (queryTerms.length === 0) return text;

    const docs = paragraphs.map(tokenize);
    const N = docs.length;
    const avgDL = docs.reduce((sum, d) => sum + d.length, 0) / N;

    const df = new Map<string, number>();
    for (const doc of docs) {
        const seen = new Set(doc);
        for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
    }

    const scored = paragraphs.map((para, idx) => {
        const doc = docs[idx]!;
        const dl = doc.length;
        let score = 0;
        for (const term of queryTerms) {
            const termDf = df.get(term) || 0;
            const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
            const tf = doc.filter(t => t === term).length;
            score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgDL));
        }
        return { text: para, score, index: idx };
    });

    const topK = options.topK || DEFAULT_TOP_K;
    const minScore = options.minScore || DEFAULT_MIN_SCORE;

    const selected = scored
        .filter(s => s.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .sort((a, b) => a.index - b.index);

    if (selected.length === 0) return text;
    return selected.map(s => s.text).join('\n\n');
}

function tokenize(text: string): string[] {
    return text.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length > 1);
}
