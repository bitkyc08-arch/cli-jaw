import { codeMathFixtures } from './code-math.js';
import { markdownParityFixtures } from './markdown.js';
import { diffFixtures, imageFixtures, mermaidFixtures, pathFixtures } from './r3-embeds-links.js';
import { fenceFixtures } from './r5-fences-widgets.js';
import { xssNegativeFixtures } from './xss.js';

// CURATED REPRESENTATIVE corpus: deterministic generators plus authored KO/EN cases.
// These fixtures have no real-session provenance and must never be described as such.
export interface ExpectedSemantics {
    headings?: number;
    code?: number;
    tables?: number;
    links?: number;
    cards?: Partial<Record<'elicitation' | 'search-results' | 'dataframe' | 'chart-json' | 'compose-block', number>>;
    widgets?: number;
    mermaid?: number;
    diffs?: number;
    images?: number;
}

export interface RenderParityCorpusEntry {
    id: string;
    source: string;
    expectedSemantics: ExpectedSemantics;
    provenance: 'curated-synthetic';
}

const curated = (id: string, source: string, expectedSemantics: ExpectedSemantics): RenderParityCorpusEntry => ({
    id, source, expectedSemantics, provenance: 'curated-synthetic',
});
const fence = (kind: string, value: unknown): string => `\`\`\`${kind}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;

const byName = (name: string): string => markdownParityFixtures.find(item => item.name === name)!.source;
const validChart = fenceFixtures.chartJson[0];

export const renderParityCorpus: readonly RenderParityCorpusEntry[] = Object.freeze([
    curated('ko-en-structure', '# 한국어 Heading\n\n## English heading\n\n- 하나\n- two\n\n> 인용 quote\n\n| 이름 | Value |\n|---|---:|\n| 사과 | 2 |', { headings: 2, tables: 1 }),
    curated('nested-list', byName('nested-list'), {}),
    curated('closed-code', '```ts\nconst answer = 42;\n```', { code: 1 }),
    curated('open-code', codeMathFixtures.openFence, { code: 1 }),
    curated('math-inline-block', byName('math'), {}),
    curated('mermaid', `\`\`\`mermaid\n${mermaidFixtures.light}\n\`\`\``, { mermaid: 1 }),
    curated('unified-diff', `\`\`\`diff\n${diffFixtures.rows801}\n\`\`\``, { diffs: 1 }),
    curated('images-local-paths', `![remote](${imageFixtures[3]!.src})\n\n${pathFixtures.valid.slice(0, 2).join(' and ')}`, { images: 1 }),
    curated('links', '[public](https://example.com/docs) [relative](./docs/readme.md)', { links: 2 }),
    curated('elicitation-valid', fence('elicitation', fenceFixtures.elicitation[0]), { cards: { elicitation: 1 } }),
    curated('elicitation-invalid', fence('elicitation', fenceFixtures.elicitation[2]), { code: 1 }),
    curated('search-results-valid', fence('search-results', fenceFixtures.searchResults[0]), { links: 1, cards: { 'search-results': 1 } }),
    curated('search-results-invalid', fence('search-results', { schemaVersion: 'bad', results: [] }), { code: 1 }),
    curated('dataframe-valid', fence('dataframe', fenceFixtures.dataframe), { tables: 1, cards: { dataframe: 1 } }),
    curated('dataframe-invalid', fence('dataframe', { schemaVersion: 'dataframe-v0' }), { code: 1 }),
    curated('chart-json-valid', fence('chart-json', validChart), { cards: { 'chart-json': 1 } }),
    curated('chart-json-invalid', fence('chart-json', fenceFixtures.chartJson[3]), { code: 1 }),
    curated('compose-block-valid', fence('compose-block', fenceFixtures.composeBlock), { cards: { 'compose-block': 1 } }),
    curated('compose-block-invalid', fence('compose-block', { schemaVersion: 'compose-block-v0' }), { code: 1 }),
    curated('diagram-html-widget', fence('diagram-html', '<!doctype html><button>Widget</button>'), { widgets: 1 }),
    curated('diagram-file-widget', fence('diagram-file', 'fixture-widget-id'), { widgets: 1 }),
]);

export const streamingParityIds = Object.freeze([
    'ko-en-structure', 'closed-code', 'math-inline-block', 'mermaid', 'unified-diff',
    'elicitation-valid', 'diagram-html-widget',
] as const);

export const curatedRepresentativeXssCorpus = Object.freeze(xssNegativeFixtures.map((source, index) => curated(
    `xss-${index + 1}`, source, {},
)));
