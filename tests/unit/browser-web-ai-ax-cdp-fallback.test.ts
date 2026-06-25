import test from 'node:test';
import assert from 'node:assert/strict';
import { cdpNodesToAxTree } from '../../src/browser/web-ai/ax-snapshot.js';

// 104.19: when page.accessibility.snapshot is gone (Playwright >=1.55), the AX tree is
// captured via CDP. cdpNodesToAxTree maps the flat CDP node list to the nested AxNode shape.
type N = Parameters<typeof cdpNodesToAxTree>[0][number];

test('BWAI-AXCDP-001: nests children, aliases CDP roles, maps state properties', () => {
    const nodes: N[] = [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2', '3'] },
        { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Hello' } },
        { nodeId: '3', role: { value: 'button' }, name: { value: 'Click' }, properties: [{ name: 'disabled', value: { value: true } }, { name: 'level', value: { value: 2 } }] },
    ];
    const tree = cdpNodesToAxTree(nodes, { interactiveOnly: false });
    assert.equal(tree.role, 'RootWebArea');
    assert.equal(tree.children?.length, 2);
    assert.equal(tree.children?.[0]?.role, 'text', 'StaticText aliases to text');
    assert.equal(tree.children?.[1]?.role, 'button');
    assert.equal(tree.children?.[1]?.disabled, true);
    assert.equal(tree.children?.[1]?.level, 2);
});

test('BWAI-AXCDP-002: interactiveOnly collapses unnamed generic nodes, lifting their children', () => {
    const nodes: N[] = [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'] },
        { nodeId: '2', role: { value: 'generic' }, name: { value: '' }, childIds: ['3'] }, // collapsible
        { nodeId: '3', role: { value: 'link' }, name: { value: 'Home' } },
    ];
    const tree = cdpNodesToAxTree(nodes, { interactiveOnly: true });
    assert.equal(tree.role, 'RootWebArea');
    assert.equal(tree.children?.length, 1);
    assert.equal(tree.children?.[0]?.role, 'link', 'the link lifts up past the collapsed generic');
});

test('BWAI-AXCDP-003: empty node list yields an empty document', () => {
    const tree = cdpNodesToAxTree([], { interactiveOnly: false });
    assert.equal(tree.role, 'document');
    assert.deepEqual(tree.children, []);
});
