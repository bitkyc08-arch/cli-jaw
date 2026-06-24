import test from 'node:test';
import assert from 'node:assert/strict';
import { bm25Filter } from '../../src/browser/adaptive-fetch/bm25-filter.js';

test('bm25Filter returns top relevant paragraphs for query', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
        i % 3 === 0 ? `Node.js performance optimization benchmark results test ${i}` : `Unrelated content about cooking recipes number ${i}`
    );
    const text = paragraphs.join('\n\n');
    const result = bm25Filter(text, { query: 'Node.js performance', topK: 5 });
    const resultParas = result.split('\n\n');
    assert.ok(resultParas.length <= 5, `expected at most 5 paragraphs, got ${resultParas.length}`);
    assert.ok(resultParas.every(p => p.includes('Node.js') || p.includes('performance')), 'all returned paragraphs should be relevant');
});

test('bm25Filter returns original text when no query', () => {
    const text = 'Short text\n\nAnother paragraph';
    const result = bm25Filter(text, { query: '', topK: 15 });
    assert.equal(result, text);
});

test('bm25Filter returns original text when under topK paragraphs', () => {
    const text = 'Para 1\n\nPara 2\n\nPara 3';
    const result = bm25Filter(text, { query: 'test', topK: 15 });
    assert.equal(result, text, 'should return original when paragraph count <= topK');
});

test('bm25Filter preserves reading order', () => {
    const paragraphs = [
        'First paragraph about Node.js',
        'Second irrelevant paragraph',
        'Third paragraph about Node.js performance',
        'Fourth irrelevant paragraph',
        'Fifth paragraph about Node.js benchmarks',
    ];
    const text = paragraphs.join('\n\n');
    const result = bm25Filter(text, { query: 'Node.js', topK: 3 });
    const resultParas = result.split('\n\n');
    const indices = resultParas.map(p => paragraphs.indexOf(p));
    for (let i = 1; i < indices.length; i++) {
        assert.ok(indices[i]! > indices[i - 1]!, 'paragraphs should be in original order');
    }
});
