// wp12 DS-4 — enumerate every state render branch in dashboard2, from the AST.
//
// This is the third attempt at a denominator and the second attempt at a tool.
// The history is worth keeping because each failure was a different mistake:
//
//   hand count #1 (12)   counted CSS class names, not render branches
//   hand count #2 (65)   regex missed -error / -loading / -notice entirely
//   hand count #3 (90)   still missed hover dock, TerminalPanel, the Code gate
//   line-based tool(130) missed dynamic role={...}, merged two branches sharing
//                        one line, and misread neighbouring conditions as axis
//                        signal (`!error` made "No matching commands" an error)
//
// A line is not a unit of anything. This walks the TypeScript AST instead, so a
// branch is a JSX element and its axis comes from the condition that guards it
// rather than from whatever text happens to sit nearby.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'public/dashboard2/src');

export type Axis = 'empty' | 'loading' | 'error' | 'prerequisite' | 'unsupported';
export type Target = 'StatePanel' | 'InlineState' | 'Alert' | 'FieldError' | 'Skeleton';

/** The primitives DS-4 migrates onto. Recognised as callsites once they exist. */
const PRIMITIVES = new Set<Target>(['StatePanel', 'InlineState', 'Alert', 'FieldError', 'Skeleton']);

export interface Branch {
    id: string;
    file: string;
    line: number;
    axis: Axis;
    target: Target;
    guard: string;
    text: string;
    /** `raw` = still a hand-rolled div; `primitive` = already migrated. */
    form: 'raw' | 'primitive';
}

export function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
        else if (entry.endsWith('.tsx')) out.push(full);
    }
    return out;
}

const STATE_WORD = /(empty|placeholder|loading|error|notice|unavailable|missing|skeleton|state|message|conflict|offline|unsupported|warning|gate)/i;

/** Class names that name a state surface but are not one. */
const NOT_A_STATE = /d2-(employee-state|widget-state|status|active-mark|pending-status|schedule-dispatch-result|code-model-note|model-settings-status)\b/;

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
    return el.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
    );
}

function attrText(el: ts.JsxOpeningLikeElement, name: string): string {
    const found = attr(el, name);
    if (!found?.initializer) return '';
    return found.initializer.getText();
}

/** Roles that mean "I am content or a control", not "I am a state message". */
const CONTENT_ROLE = /listitem|list\b|tree\b|treeitem|button|link|tab\b|tablist|menu|menuitem|row|grid|table|article|region|dialog|listbox|option|form|search|toolbar|navigation|banner|main|complementary/;

/**
 * Does this element announce itself as a state surface?
 *
 * `role={...}` counts: SettingsToast and TerminalPanel compute their role from
 * severity, and a line-based check missed both.
 *
 * `aria-busy` deliberately does NOT count on its own. It is an accessibility
 * annotation on content that already exists — a board card being saved, a tree
 * whose children are refreshing — and treating it as a state surface both
 * over-counted controls and double-counted the real loading branch nested
 * inside the busy container.
 */
export function isStateElement(el: ts.JsxOpeningLikeElement): boolean {
    const cls = attrText(el, 'className');
    const role = attrText(el, 'role');
    // A migrated callsite is a state branch by definition.
    if (PRIMITIVES.has(el.tagName.getText() as Target)) return true;
    if (NOT_A_STATE.test(cls)) return false;
    // A screen-reader-only live region has no visible typography to migrate.
    if (/sr-only/.test(cls)) return false;
    // A tag that is itself a control or a content container cannot be a
    // placeholder, however it is annotated.
    const tag = el.tagName.getText();
    if (/^(button|a|input|select|textarea|article|li|ol|ul|form|nav|table|tr|td)$/.test(tag)) return false;
    if (CONTENT_ROLE.test(role)) return false;
    if (cls && STATE_WORD.test(cls)) return true;
    if (/alert|status/.test(role)) return true;
    return false;
}

/**
 * The element's OWN visible text.
 *
 * Collecting the whole subtree let a container absorb its children's axis: the
 * reminders wrapper read as `error` because an error banner was nested three
 * levels down. Descend only through elements that carry no state of their own.
 */
export function textOf(node: ts.Node): string {
    const parts: string[] = [];
    const walk = (n: ts.Node, depth: number): void => {
        if (ts.isJsxText(n)) { parts.push(n.text); return; }
        if (depth > 0) {
            const inner = ts.isJsxElement(n) ? n.openingElement
                : ts.isJsxSelfClosingElement(n) ? n
                    : undefined;
            // A nested state element owns its text; do not steal it.
            if (inner && isStateElement(inner)) return;
        }
        if (ts.isStringLiteral(n) && depth <= 2) parts.push(n.text);
        n.forEachChild(child => walk(child, depth + 1));
    };
    walk(node, 0);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The nearest enclosing condition. This is what a line-based scan could never
 * see: `status === 'error'` names the axis even when the element renders a
 * runtime string.
 */
export function guardOf(node: ts.Node): string {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isConditionalExpression(n)) {
            const inTrue = n.whenTrue.getStart() <= node.getStart() && node.getEnd() <= n.whenTrue.getEnd();
            return inTrue ? n.condition.getText() : `!(${n.condition.getText()})`;
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            return n.left.getText();
        }
        if (ts.isIfStatement(n)) {
            // An early-return chain guards each branch with the negation of every
            // condition before it. Without that, the else-side reads as if the
            // `if` had matched.
            const inThen = n.thenStatement.getStart() <= node.getStart() && node.getEnd() <= n.thenStatement.getEnd();
            return inThen ? n.expression.getText() : `!(${n.expression.getText()})`;
        }
        // A `return` that merely follows a guard chain is not inside any `if`.
        // FileTreePanel and TerminalPanel are written this way, and reading no
        // guard at all made their final branches unclassifiable.
        if (ts.isReturnStatement(n) && n.parent && ts.isBlock(n.parent)) {
            const preceding = n.parent.statements
                .filter((s): s is ts.IfStatement => ts.isIfStatement(s) && s.getEnd() <= n.getStart())
                .map(s => `!(${s.expression.getText()})`);
            if (preceding.length) return preceding.join(' && ');
        }
    }
    return '';
}

/** Is `error` present other than under a negation? */
export function hasPositiveError(guard: string): boolean {
    // Strip every negated comparison and every `!foo` before looking. Without
    // this, `status !== 'error'` and `!error && ...` both read as errors.
    const stripped = guard
        .replace(/!==\s*'[^']*'/g, '')
        .replace(/!\(?[\w.?[\]]*error[\w.?[\]]*\)?/gi, '')
        .replace(/no matching|unavailable/gi, '');
    return /error|conflict|failed/i.test(stripped);
}

export function axisOf(guard: string, text: string, cls: string): Axis {
    const g = guard.toLowerCase();
    const t = `${text} ${cls}`.toLowerCase();

    // Visible copy outranks the guard when it is unambiguous. `error` as a
    // guard means "the fetch failed", but the element may say "Commands
    // unavailable" — which is the unsupported axis, not an error banner.
    if (/coming soon|not supported|requires |unavailable/.test(t)) return 'unsupported';
    if (/select an? |open a |enter a url|no instance selected/.test(t)) return 'prerequisite';

    // Guard next: it states intent, while remaining text may be a runtime value.
    if (/unsupported|unavailable|not_?supported|missing_binary|acp_unsupported|capability/.test(g)) return 'unsupported';
    if (hasPositiveError(guard)) return 'error';
    // Loading outranks empty: `loading && tasks.length === 0` is the first load
    // of an empty-so-far list, which is a spinner, not an empty state. But
    // `!loading && ... .length === 0` is the settled empty result, so a negated
    // loading flag must not win.
    const loadingActive = /=== ?'loading'|isloading|\bloading\b|busy|probing|=== ?'saving'|submitting/.test(g)
        && !/![\w.?]*loading/.test(g);
    if (loadingActive) return 'loading';
    if (/\.length === 0|!\w+\.length|isempty|=== ?'empty'|!selected|!path/.test(g)) return 'empty';
    if (/=== ?null|!port|!reporoot|!session|!instance|needssession|!question|!\w+selected/.test(g)) return 'prerequisite';

    if (/coming soon|not supported|unsupported|unavailable|requires /.test(t)) return 'unsupported';
    if (/select an? |open a |enter a url|no instance selected/.test(t)) return 'prerequisite';
    if (/error|conflict|failed|warning/.test(t)) return 'error';
    if (/loading|resolving|preparing|truncated|limit reached|oversize|saving/.test(t)) return 'loading';
    if (/\bno [\w{]|empty|nothing|start of history/.test(t)) return 'empty';
    // Nothing static says otherwise; a bare status region is a progress report.
    return 'loading';
}

export function targetOf(cls: string, axis: Axis, role: string, file: string): Target {
    if (/field-error/.test(cls)) return 'FieldError';
    if (/skeleton/i.test(cls)) return 'Skeleton';
    if (axis === 'error' && !/placeholder|pane-empty|side-pane|gate/.test(cls)) return 'Alert';
    if (/warning|notice|toast/.test(cls)) return 'Alert';
    if (/inline-state|menu-state|tree-state|modal-empty|reminders-loading|notes-loading|browser-loading|settings-empty|lifecycle-message/.test(cls)) return 'InlineState';
    if (/Menu|Palette|QuickSwitcher|Sidebar/.test(file) && axis === 'empty') return 'InlineState';
    if (/alert/.test(role) && /placeholder/.test(cls)) return 'StatePanel';
    return 'StatePanel';
}

/**
 * A stable identifier that must survive the migration itself.
 *
 * The first version hashed file + className + guard + text. That breaks the
 * moment a branch migrates: `<div className="d2-panel-state">Loading…</div>`
 * becomes `<StatePanel kind="loading">`, the class and text both change, and
 * the branch reads as one id vanishing and a different one appearing — which
 * regenerating the manifest would silently absorb. A gate that cannot tell
 * "migrated" from "deleted" is not a gate.
 *
 * The guard is the one thing migration preserves: the condition that decides
 * whether the branch renders is the same before and after. So identity is
 * file + guard, with the enclosing function to separate branches that share a
 * guard expression.
 */
export function branchId(file: string, fn: string, guard: string): string {
    const base = `${file}|${fn}|${guard}`;
    let h = 0;
    for (let i = 0; i < base.length; i += 1) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
    const slug = (guard.match(/[a-zA-Z][\w.]{2,}/)?.[0] ?? 'state').replace(/[^\w]/g, '').slice(0, 20);
    return `${file.split('/').pop()?.replace('.tsx', '')}-${slug}-${(h >>> 0).toString(36)}`;
}

/** The nearest named function, so two branches with one guard stay distinct. */
function enclosingFunction(node: ts.Node): string {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name) return n.name.getText();
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.getText();
        if (ts.isMethodDeclaration(n) && n.name) return n.name.getText();
    }
    return '';
}

const branches: Branch[] = [];
/** Distinguishes branches that are identical apart from where they appear. */
const seen = new Map<string, number>();

for (const file of tsxFiles(SRC)) {
    const rel = relative(ROOT, file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visit = (node: ts.Node): void => {
        const opening = ts.isJsxElement(node) ? node.openingElement
            : ts.isJsxSelfClosingElement(node) ? node
                : undefined;
        if (opening && isStateElement(opening)) {
            const cls = attrText(opening, 'className');
            const role = attrText(opening, 'role');
            const text = textOf(node);
            const guard = guardOf(node);
            const axis = axisOf(guard, text, cls);
            const tag = opening.tagName.getText();
            const base = branchId(rel, enclosingFunction(node), guard);
            // CodeTab renders the same listError banner in two layouts. They are
            // separate branches, so the id must separate them too.
            const nth = (seen.get(base) ?? 0) + 1;
            seen.set(base, nth);
            branches.push({
                id: nth === 1 ? base : `${base}#${nth}`,
                file: rel,
                line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                axis,
                target: targetOf(cls, axis, role, rel),
                guard: guard.slice(0, 80),
                text: text.slice(0, 80),
                form: PRIMITIVES.has(tag as Target) ? 'primitive' : 'raw',
            });
        }
        node.forEachChild(visit);
    };
    visit(source);
}

const tally = <K extends keyof Branch>(key: K): Record<string, number> =>
    branches.reduce<Record<string, number>>((acc, b) => ({ ...acc, [String(b[key])]: (acc[String(b[key])] ?? 0) + 1 }), {});

const byFile = branches.reduce<Record<string, number>>((acc, b) => ({ ...acc, [b.file]: (acc[b.file] ?? 0) + 1 }), {});
const duplicateIds = Object.entries(
    branches.reduce<Record<string, number>>((acc, b) => ({ ...acc, [b.id]: (acc[b.id] ?? 0) + 1 }), {}),
).filter(([, n]) => n > 1);

export const manifest = {
    total: branches.length,
    files: Object.keys(byFile).length,
    byAxis: tally('axis'),
    byTarget: tally('target'),
    byForm: tally('form'),
    duplicateIds,
    byFileDesc: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1])),
    branches: branches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
};

// Printing only when run directly keeps this importable by the gate test.
if (process.argv[1]?.endsWith('enumerate-states.mts')) {
    console.log(JSON.stringify(manifest, null, 2));
}
