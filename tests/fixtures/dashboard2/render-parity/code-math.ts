const ascii = (bytes: number): string => 'x'.repeat(bytes);

export const codeMathFixtures = Object.freeze({
    aliases: Object.freeze(['js', 'ts', 'py', 'sh', 'yml', 'rs', 'c', 'text', 'plaintext']),
    unknownLanguage: 'made-up-language',
    code8192: ascii(8192), code8193: ascii(8193),
    code204800: ascii(204800), code204801: ascii(204801),
    openFence: '```ts\nconst 아직 = true;',
    comments: '```ts\n// 한국어 주석\n// English comment\nconst ok = true;\n```',
    math: 'inline $x + y$ and block $$\\sum_{i=0}^n i$$ plus \\(a/b\\) and \\[c^2\\]',
    malformedMath: '$$\\frac{$$',
    tex32768: ascii(32768), tex32769: ascii(32769),
});
