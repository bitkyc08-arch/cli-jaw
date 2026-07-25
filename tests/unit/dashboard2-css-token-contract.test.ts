// 260726 wp5vis — every CSS custom property a stylesheet reads must resolve.
//
// Two live defects motivated this. `--status-error` was never defined in
// dashboard2's token file, so error text computed to exactly the body colour and
// nothing looked wrong to the eye. `--syntax-link` was missing from an otherwise
// complete syntax family, so ANSI blue silently collapsed into body text while
// every other ANSI colour rendered.
//
// A declaration that references a missing token is dropped by the browser in
// silence. That is precisely the class of bug a human reviewer will not catch and
// a gate will.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DASHBOARD2 = join(ROOT, 'public/dashboard2/src');
const TOKENS = join(DASHBOARD2, 'styles/tokens-v4.css');

/**
 * Tokens written by JavaScript at runtime rather than declared in CSS.
 *
 * Each entry names the injection site so this list stays auditable: a token
 * cannot be excused by adding its name here, only by pointing at the code that
 * actually sets it.
 */
const RUNTIME_INJECTED: Record<string, string> = {
    '--d2-sidebar-w': 'shell/Shell.tsx sets it via style.setProperty during resize',
    '--d2-pane-w': 'shell/Workbench.tsx sets it via style.setProperty during resize',
    '--d2-widget-estimated-height': 'turn-stream widget runtime sets it per widget',
    '--phase-color': 'chat/composer/ComposerFooter.tsx injects it per phase',
};

function cssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...cssFiles(full));
        else if (entry.endsWith('.css')) out.push(full);
    }
    return out;
}

/**
 * Every custom property NAME declared anywhere in dashboard2's own CSS.
 *
 * tokens-v4.css is the canonical source, but a stylesheet may legitimately
 * declare a local alias next to where it is used (base.css does this for
 * --d2-sidebar), and those are just as resolvable at runtime.
 */
function declaredTokens(): Set<string> {
    const names = new Set<string>();
    for (const file of cssFiles(DASHBOARD2)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
            names.add(match[1]!);
        }
    }
    return names;
}

/** Only the canonical token file, for the per-theme completeness checks. */
function canonicalTokens(): Set<string> {
    const source = readFileSync(TOKENS, 'utf8');
    return new Set([...source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map(m => m[1]!));
}

/**
 * Splits `var(--name, fallback)` into its parts, respecting nesting so that
 * `var(--a, var(--b, red))` yields name `--a` and fallback `var(--b, red)`.
 */
function parseVarRefs(css: string): Array<{ name: string; fallback: string | null }> {
    const refs: Array<{ name: string; fallback: string | null }> = [];
    for (let i = css.indexOf('var('); i !== -1; i = css.indexOf('var(', i + 1)) {
        let depth = 1;
        let j = i + 4;
        for (; j < css.length && depth > 0; j += 1) {
            if (css[j] === '(') depth += 1;
            else if (css[j] === ')') depth -= 1;
        }
        const inner = css.slice(i + 4, j - 1);
        const comma = (() => {
            let d = 0;
            for (let k = 0; k < inner.length; k += 1) {
                if (inner[k] === '(') d += 1;
                else if (inner[k] === ')') d -= 1;
                else if (inner[k] === ',' && d === 0) return k;
            }
            return -1;
        })();
        const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
        const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
        if (name.startsWith('--')) refs.push({ name, fallback });
    }
    return refs;
}

/**
 * A reference is satisfied when the token exists, is injected at runtime, or its
 * fallback chain terminates in something real.
 *
 * The recursion matters: accepting any `var(--x, ...)` on syntax alone would let
 * `var(--x, var(--also-missing))` through, which resolves to nothing at runtime.
 */
function resolves(name: string, fallback: string | null, declared: Set<string>): boolean {
    if (declared.has(name) || name in RUNTIME_INJECTED) return true;
    if (fallback === null) return false;
    const nested = parseVarRefs(fallback);
    if (nested.length === 0) return fallback.length > 0;      // terminal literal
    return nested.every(ref => resolves(ref.name, ref.fallback, declared));
}

test('every referenced CSS token resolves, directly or through its fallback chain', () => {
    const declared = declaredTokens();
    const unresolved: string[] = [];

    for (const file of cssFiles(DASHBOARD2)) {
        for (const ref of parseVarRefs(readFileSync(file, 'utf8'))) {
            if (!resolves(ref.name, ref.fallback, declared)) {
                unresolved.push(`${relative(ROOT, file)}: ${ref.name}`);
            }
        }
    }

    assert.deepEqual(
        unresolved,
        [],
        'a declaration referencing an undefined token is dropped silently by the browser',
    );
});

test('the syntax colour family is complete', () => {
    const declared = canonicalTokens();
    // ANSI foreground colours map onto this family; one missing member means that
    // colour silently renders as body text while its siblings look correct.
    const family = ['--syntax-fg', '--syntax-delete', '--syntax-insert', '--syntax-keyword', '--syntax-string', '--syntax-number', '--syntax-function'];
    const missing = family.filter(token => !declared.has(token));
    assert.deepEqual(missing, [], 'a partially defined colour family fails invisibly');
});

test('error styling uses the canonical danger token', () => {
    const turnStream = readFileSync(join(DASHBOARD2, 'styles/turn-stream.css'), 'utf8');

    // --status-error belongs to the manager token file, which dashboard2 does not
    // load; referencing it here made error text identical to body text.
    assert.equal(turnStream.includes('--status-error'), false, 'dashboard2 does not define --status-error');
    for (const selector of ['.d2-segment-status.is-error', '.d2-math-slot.is-error', '.d2-math-slot__label']) {
        assert.ok(turnStream.includes(selector), `${selector} must still exist`);
    }
    assert.ok(turnStream.includes('var(--danger)'), 'error styling must use the token that is actually defined');
});

test('rendered markdown carries no outer whitespace', () => {
    const coalescer = readFileSync(join(DASHBOARD2, 'turn-stream/render/parse-coalescer.ts'), 'utf8');

    // marked appends a newline after the outermost tag; inherited pre-wrap turns
    // it into a visible blank line, inflating a one-line bubble by a full line.
    assert.match(
        coalescer,
        /marked\.parse\([^)]*\)\.trim\(\)/,
        'the serializer newline must be trimmed at the outer edge only',
    );
});
