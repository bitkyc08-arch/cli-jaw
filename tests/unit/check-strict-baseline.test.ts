// @file tests/unit/check-strict-baseline.test.ts
// AST scanner negative tests (R2.2.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error - importing .mjs from ts test
import { scanText, parseBaseline } from '../../scripts/check-strict-baseline.mjs';

function counts(src: string) {
    return scanText(src, 'fixture.ts') as { any: number; debt: number; allow: number };
}

test('detects: explicit annotation `: any`', () => {
    assert.equal(counts('export const x: any = 1;\n').any, 1);
});

test('detects: type assertion `as any`', () => {
    assert.equal(counts('export const y = (1 as any);\n').any, 1);
});

test('detects: generic position Array<any>', () => {
    assert.equal(counts('export type A = Array<any>;\n').any, 1);
});

test('detects: index signature Record<string, any>', () => {
    assert.equal(counts('export type B = Record<string, any>;\n').any, 1);
});

test('detects: rest parameter any[]', () => {
    assert.equal(counts('export function f(...args: any[]) { return args; }\n').any, 1);
});

test('ignores: literal `: any` inside a single-line comment', () => {
    assert.equal(counts('// : any\nexport const x = 1;\n').any, 0);
});

test('ignores: literal `: any` inside a string literal', () => {
    assert.equal(counts('export const s = ": any";\n').any, 0);
});

test('@strict-debt(P##) marker shifts count from any to debt', () => {
    const c = counts(
        '// @strict-debt(P11): TODO replace after fixture coverage\n' +
        'export function legacy(event: any) { return event; }\n',
    );
    assert.equal(c.any, 0);
    assert.equal(c.debt, 1);
});

test('@strict-allow-any(<reason>) marker shifts to allow column', () => {
    const c = counts(
        '// @strict-allow-any(contract): JSON-RPC payload\n' +
        'export type Payload = Record<string, any>;\n',
    );
    assert.equal(c.any, 0);
    assert.equal(c.allow, 1);
});

test('parseBaseline reads the AST baseline doc', () => {
    const txt = `# baseline\n## any-shapes baseline\n` +
        `| dir | any | debt | allow |\n|-----|----:|-----:|------:|\n` +
        `| src | 643 | 0 | 0 |\n`;
    const b = parseBaseline(txt) as Record<string, { any: number; debt: number; allow: number }>;
    assert.equal(b.src.any, 643);
});
