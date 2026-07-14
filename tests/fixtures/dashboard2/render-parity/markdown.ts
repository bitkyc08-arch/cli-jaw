export interface MarkdownParityFixture { name: string; source: string }

export const markdownParityFixtures: MarkdownParityFixture[] = [
    { name: 'mixed-table', source: '| 이름 | Value |\n|---|---:|\n| 사과 | 2 |\n| pear | 3 |' },
    { name: 'nested-list', source: '- 하나\n  1. two\n     - **셋**\n- four' },
    { name: 'long-fence', source: `before\n\n\`\`\`ts\n${'const 값 = 1;\n'.repeat(200)}\`\`\`\nafter` },
    { name: 'cjk-boundary', source: '**한국어 문장!)**다음과 **테스트.**끝' },
    { name: 'orchestration', source: 'keep\n```json\n{"subtasks":[]}\n```\nafter' },
    { name: 'ordinary-json', source: '```json\n{"phase":"normal","value":1}\n```' },
    { name: 'math', source: 'inline $x+y$ and\n\n$$\nx^2+y^2\n$$' },
    { name: 'images-links', source: '![alt](https://example.com/a.png) [local](./notes/file.md) [mail](mailto:a@example.com)' },
    { name: 'local-path', source: '`/Users/example/문서/file.md` and `C:\\temp\\a.txt`' },
];

export const mediumMarkdownFixture: MarkdownParityFixture = {
    name: 'synthetic-300kib', source: '가나다 abc **bold**\n'.repeat(Math.ceil(300 * 1024 / 20)).slice(0, 300 * 1024),
};
export const oversizeMarkdownFixture: MarkdownParityFixture = {
    name: 'synthetic-over-1mib', source: 'stream line 가나다 12345\n'.repeat(Math.ceil(1024 * 1024 / 24) + 2),
};
