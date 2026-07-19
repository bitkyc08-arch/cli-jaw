import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const SRC_ROOT = new URL('../../public/dashboard2/src/', import.meta.url).pathname;

function collectTsx(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectTsx(path));
        else if (entry.name.endsWith('.tsx')) out.push(path);
    }
    return out;
}

const INTERACTIVE_ROLES = new Set(['button', 'tab', 'switch', 'link', 'menuitem', 'checkbox', 'radio']);

function interactiveTagOf(node) {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return null;
    const tagExpr = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = tagExpr.tagName.getText();
    if (tag === 'button' || tag === 'a') return tag;
    for (const prop of tagExpr.attributes.properties) {
        if (ts.isJsxAttribute(prop) && prop.name.getText() === 'role' && prop.initializer) {
            const init = prop.initializer;
            if (ts.isStringLiteral(init) && INTERACTIVE_ROLES.has(init.text)) return `role=${init.text}`;
            if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) && INTERACTIVE_ROLES.has(init.expression.text)) {
                return `role=${init.expression.text}`;
            }
        }
    }
    return null;
}

// 정적 JSX 구조 기준 (런타임 polymorphic/createElement 조합은 범위 밖 — 020 감사 반영)
function findNestedInteractive(filePath) {
    const source = readFileSync(filePath, 'utf8');
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const violations = [];
    function walk(node, ancestorChain) {
        const tag = interactiveTagOf(node);
        if (tag) {
            const outer = ancestorChain[ancestorChain.length - 1];
            if (outer) violations.push(`${filePath}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${outer} > ${tag}`);
            ancestorChain = [...ancestorChain, tag];
        }
        ts.forEachChild(node, (child) => walk(child, ancestorChain));
    }
    walk(sf, []);
    return violations;
}

test('no nested interactive elements in dashboard2 tsx (static JSX structure)', () => {
    const files = collectTsx(SRC_ROOT);
    assert.ok(files.length > 50, `expected 50+ tsx files, got ${files.length}`);
    const violations = files.flatMap(findNestedInteractive);
    assert.deepEqual(violations, []);
});

function cssBlockOf(css, selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `missing selector block: ${selector}`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('side-pane pill tab button carries a chrome reset in its own block', () => {
    const css = readFileSync(new URL('../../public/dashboard2/src/styles/workbench-v4.css', import.meta.url), 'utf8');
    const block = cssBlockOf(css, ".d2-side-pane-pill > button[role='tab']");
    assert.match(block, /border:\s*0/);
    assert.match(block, /background:\s*transparent/);
});

test('tray reminder action buttons keep transparent border in their own block', () => {
    const css = readFileSync(new URL('../../public/dashboard2/src/features/reminders/reminders.css', import.meta.url), 'utf8');
    const block = cssBlockOf(css, '.d2-tray-reminder-card .d2-reminders-card-actions button');
    assert.match(block, /border-color:\s*transparent/);
});
