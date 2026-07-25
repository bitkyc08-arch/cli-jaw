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

type Axis = 'empty' | 'loading' | 'error' | 'prerequisite' | 'unsupported';
type Target = 'StatePanel' | 'InlineState' | 'Alert' | 'FieldError' | 'Skeleton';

interface Branch {
    id: string;
    file: string;
    line: number;
    axis: Axis;
    target: Target;
    guard: string;
    text: string;
}

function tsxFiles(dir: string): string[] {
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

/**
 * Does this element announce itself as a state surface?
 *
 * `role={...}` counts: SettingsToast and TerminalPanel compute their role from
 * severity, and a line-based check missed both.
 */
function isStateElement(el: ts.JsxOpeningLikeElement): boolean {
    const cls = attrText(el, 'className');
    const role = attrText(el, 'role');
    if (NOT_A_STATE.test(cls)) return false;
    // A screen-reader-only live region has no visible typography to migrate.
    if (/sr-only/.test(cls)) return false;
    if (cls && STATE_WORD.test(cls)) return true;
    if (/alert|status/.test(role)) return true;
    if (attrText(el, 'aria-busy')) return true;
    return false;
}

/** Visible text inside an element, so `dynamic` stays a last resort. */
function textOf(node: ts.Node): string {
    const parts: string[] = [];
    const walk = (n: ts.Node): void => {
        if (ts.isJsxText(n)) parts.push(n.text);
        else if (ts.isStringLiteral(n)) parts.push(n.text);
        n.forEachChild(walk);
    };
    walk(node);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The nearest enclosing condition. This is what a line-based scan could never
 * see: `status === 'error'` names the axis even when the element renders a
 * runtime string.
 */
function guardOf(node: ts.Node): string {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isConditionalExpression(n)) {
            // Only the true-branch is guarded by the condition.
            if (n.whenTrue === node || n.whenTrue.getStart() <= node.getStart() && node.getEnd() <= n.whenTrue.getEnd()) {
                return n.condition.getText();
            }
            return `!(${n.condition.getText()})`;
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            return n.left.getText();
        }
        if (ts.isIfStatement(n)) return n.expression.getText();
    }
    return '';
}

function axisOf(guard: string, text: string, cls: string): Axis {
    const g = guard.toLowerCase();
    const t = `${text} ${cls}`.toLowerCase();

    // Visible copy outranks the guard when it is unambiguous. `error` as a
    // guard means "the fetch failed", but the element may say "Commands
    // unavailable" — which is the unsupported axis, not an error banner.
    if (/coming soon|not supported|requires |unavailable/.test(t)) return 'unsupported';
    if (/select an? |open a |enter a url|no instance selected/.test(t)) return 'prerequisite';

    // Guard next: it states intent, while remaining text may be a runtime value.
    if (/unsupported|unavailable|not_?supported|missing_binary|acp_unsupported|capability/.test(g)) return 'unsupported';
    // A negated guard is not the axis. `!error && commands.length === 0` is an
    // empty list, and matching bare `error` inside it put that branch in Alert.
    const positiveError = /(^|[^!\w])error\b|=== ?'error'|\.error\b|iserror|haserror|conflict|failed/.test(g)
        && !/^!/.test(g.trim());
    if (positiveError) return 'error';
    if (/\.length === 0|!\w+\.length|isempty|=== ?'empty'|!selected|!path/.test(g)) return 'empty';
    if (/=== ?'loading'|isloading|\bloading\b|busy|probing|=== ?'saving'|submitting/.test(g)) return 'loading';
    if (/=== ?null|!port|!reporoot|!session|!instance|needssession|!question|!\w+selected/.test(g)) return 'prerequisite';

    if (/coming soon|not supported|unsupported|unavailable|requires /.test(t)) return 'unsupported';
    if (/select an? |open a |enter a url|no instance selected/.test(t)) return 'prerequisite';
    if (/error|conflict|failed|warning/.test(t)) return 'error';
    if (/loading|resolving|preparing|truncated|limit reached|oversize|saving/.test(t)) return 'loading';
    if (/\bno [\w{]|empty|nothing|start of history/.test(t)) return 'empty';
    // Nothing static says otherwise; a bare status region is a progress report.
    return 'loading';
}

function targetOf(cls: string, axis: Axis, role: string, file: string): Target {
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
 * A stable identifier that survives edits. Line numbers move on every commit,
 * so DS-4 cannot track branches by position.
 */
function branchId(file: string, cls: string, guard: string, text: string): string {
    const base = `${file}|${cls}|${guard}|${text}`;
    let h = 0;
    for (let i = 0; i < base.length; i += 1) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
    const slug = (cls.match(/[a-z0-9-]{4,}/i)?.[0] ?? 'state').slice(0, 24);
    return `${slug}-${(h >>> 0).toString(36)}`;
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
            const base = branchId(rel, cls, guard, text);
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

console.log(JSON.stringify({
    total: branches.length,
    files: Object.keys(byFile).length,
    byAxis: tally('axis'),
    byTarget: tally('target'),
    duplicateIds,
    byFileDesc: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1])),
    branches: branches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
}, null, 2));
