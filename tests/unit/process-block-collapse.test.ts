import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourcePath = join(process.cwd(), 'public/js/features/process-block.ts');
const source = readFileSync(sourcePath, 'utf8');

function functionBlock(name: string): string {
    const start = source.indexOf(`function ${name}`) >= 0
        ? source.indexOf(`function ${name}`)
        : source.indexOf(`export function ${name}`);
    assert.ok(start >= 0, `${name} should exist`);
    const tail = source.slice(start);
    const next = tail.slice(1).search(/\n(?:export )?function /);
    return next >= 0 ? tail.slice(0, next + 1) : tail;
}

test('process block static HTML defaults to collapsed', () => {
    const block = functionBlock('buildProcessBlockHtml');
    assert.match(block, /buildProcessBlockHtml\(steps: ProcessStep\[\], collapsed = true\)/);
    assert.ok(block.includes('blockShell(summaryText, collapsed)'));
});

test('process block static HTML still allows explicit expanded override', () => {
    const block = functionBlock('buildProcessBlockHtml');
    assert.ok(block.includes('collapsed = true'), 'collapsed should be the default value');
    assert.ok(block.includes('blockShell(summaryText, collapsed)'), 'explicit false should flow through to the shell');
    assert.ok(!block.includes('collapsed || true'), 'implementation must not force all callers collapsed');
});

test('createProcessBlock creates collapsed live blocks by default', () => {
    const block = functionBlock('createProcessBlock');
    assert.ok(block.includes("blockShell('', true)"), 'live block constructor should request collapsed shell');
    assert.ok(block.includes('return { element: el, steps: [], collapsed: true }'), 'state should match collapsed DOM');
    assert.ok(!block.includes("blockShell('', false)"), 'expanded shell should not be the live default');
    assert.ok(!block.includes('collapsed: false'), 'expanded state should not be the live default');
});

test('collapseBlock preserves collapsed aria state', () => {
    const block = functionBlock('collapseBlock');
    assert.ok(block.includes('pb.collapsed = true'));
    assert.ok(block.includes("pb.element.classList.add('collapsed')"));
    assert.ok(block.includes("btn.setAttribute('aria-expanded', 'false')"));
    assert.ok(block.includes('ICONS.chevronRight'));
});
