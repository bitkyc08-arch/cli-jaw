const columns = Array.from({ length: 20 }, (_, i) => `Column ${i + 1}`);
const rows = Array.from({ length: 500 }, (_, r) => columns.map((_, c) => `${r + 1}:${c + 1}`));
export const fenceFixtures = {
    elicitation: [
        { questions: [{ id: 'kind', question: 'Choose', options: ['A', 'B'] }] },
        { questions: [{ id: 'features', type: 'multi_select', question: 'Features', options: ['Fast', 'Safe'] }, { id: 'detail', question: 'Detail', visibleWhen: { features: ['Fast'] }, options: ['Now'] }] },
        '{invalid',
    ],
    searchResults: [
        { schemaVersion: 'search-results-v1', query: 'dashboard', results: [{ title: 'Public', url: 'https://example.com', snippet: 'Result' }] },
        { schemaVersion: 'search-results-v1', query: 'blocked', results: [{ url: 'http://127.0.0.1' }, { url: 'http://[fe80::1]' }] },
    ],
    dataframe: { schemaVersion: 'dataframe-v1', title: '20x500', columns, rows, pageSize: 25 },
    chartJson: [
        { schemaVersion: 'chart-json-v1', type: 'bar', labels: ['A'], data: [1] },
        { schemaVersion: 'chart-json-v1', type: 'line', labels: ['A', 'B'], data: [1, 2] },
        { schemaVersion: 'chart-json-v1', type: 'pie', labels: ['A', 'B'], data: [1, 2] },
        { schemaVersion: 'chart-json-v1', labels: [], data: [] },
    ],
    composeBlock: { schemaVersion: 'compose-block-v1', kind: 'email', title: 'Draft', variants: Array.from({ length: 3 }, (_, i) => ({ id: `v${i}`, label: `Variant ${i + 1}`, subject: `Subject ${i + 1}`, body: `Body ${i + 1}` })) },
} as const;
