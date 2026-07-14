export const mermaidFixtures = {
    light: 'flowchart LR\nA[Light] --> B[Theme]',
    dark: 'sequenceDiagram\nAlice->>Bob: Dark theme',
    malformedFlowchart: 'flowchart TD\nsrc/index[설정(config) & 초기화] --> default[Done]',
    oversizeSource: (): string => `flowchart TD\nA[${'x'.repeat(128 * 1024)}]`,
} as const;

export const diffFixtures = {
    rows801: Array.from({ length: 801 }, (_, index) => index === 0 ? '--- a/file.ts' : index === 1 ? '+++ b/file.ts' : index === 2 ? '@@ -1 +1 @@' : index % 2 ? `+added ${index}` : `-deleted ${index}`).join('\n'),
    wideTable: '| first | second | third |\n|---|---|---|\n| a very wide value | another very wide value | final value |',
};
export const imageFixtures = [
    { src: '/Users/test/.cli-jaw/uploads/a b.png', route: '/media/a%20b.png' }, { src: '/uploads/a.png', route: '/media/a.png' },
    { src: '/tmp/local.png', route: '/api/image?path=%2Ftmp%2Flocal.png' }, { src: 'https://example.com/image.png', route: 'https://example.com/image.png' },
    { src: './broken.png', alt: 'broken sample' },
];
export const pathFixtures = {
    valid: ['/Users/jun/project/file.ts', '~/notes/a.md', './src/a.ts', '../docs/readme.md', 'src/components/App.tsx'],
    invalid: ['2026/07/15', 'https://example.com/a.ts', '3/4'],
};

export const tableFixtures = {
    wide: '| Column one | Column two | Column three |\n|---|---|---|\n| alpha value that stays readable | beta value that stays readable | gamma value that stays readable |',
    inlineFlow: 'Before ![inline sample](/uploads/inline.png "Inline title") after.',
};

export const anchorFixtures = {
    stableLabel: 'stable-anchor-above-embeds',
    mermaid: '```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```',
    image: '![anchor image](/uploads/anchor.png)',
};
