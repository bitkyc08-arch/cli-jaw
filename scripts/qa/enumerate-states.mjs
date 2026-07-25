#!/usr/bin/env node
// wp12 DS-4 — enumerate every state render branch in dashboard2.
//
// Two hand-counted manifests were wrong before this existed. The first counted
// CSS class names (12) and missed that one class serves five branches. The
// second widened the class-name regex to catch -error/-loading (90) and still
// missed hover dock's 20 branches, the Code gate, tool detail, mermaid, and
// TerminalPanel — whose class names contain no state word at all.
//
// The lesson is that a class-name regex cannot be the oracle. A state branch is
// identified by what it *does*: it announces itself to assistive tech
// (role=alert / role=status / aria-busy), it is a Suspense fallback, or it
// renders a terminal message instead of the panel's real content.
//
// Output is JSON so the acceptance matrix reads a machine-produced denominator.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'public/dashboard2/src');

/**
 * Words that, in a className, mark an element as a state surface.
 *
 * `pending` is deliberately absent: `d2-pending-*` is the pending-queue
 * feature's own namespace (rows, headers, actions), not a state placeholder.
 * Including it captured eight structural elements.
 */
const STATE_CLASS = /(^|[\s"'`-])(empty|placeholder|loading|error|notice|unavailable|missing|skeleton|state|message|conflict|offline|unsupported|warning|gate)/i;

/**
 * Elements that announce to assistive tech without being a visual state
 * surface. A screen-reader-only live region has no typography to migrate, and
 * a structural container merely wraps content that exists.
 */
function isNotVisualState(line) {
    if (/d2-sr-only|\bsr-only\b|aria-live="polite"/.test(line) && /role="status"/.test(line)) return true;
    // A row-status badge labels an item that exists; it is not a placeholder.
    if (/d2-(employee-state|widget-state|status|active-mark|pending-status)\b/.test(line)) return true;
    // Inline result/progress chips sit beside working content.
    if (/d2-(schedule-dispatch-result|code-model-note|model-settings-status)\b/.test(line)) return true;
    return false;
}

function tsxFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
        else if (entry.endsWith('.tsx')) out.push(full);
    }
    return out;
}

/**
 * Classify a branch by axis. Order matters: `error` beats `loading` because
 * `role="alert"` is a stronger signal than a spinner in the same element, and a
 * prerequisite ("Select an instance") is not an empty list.
 */
function axisOf(line, context) {
    // Multi-line JSX puts the user-visible text on following lines, so the
    // opening tag alone often carries no axis signal. Classify on the element's
    // text content, not just the line the className sits on.
    const t = `${line}\n${context}`.toLowerCase();
    // `\berror\b` misses `d2-mermaid__error` because `_` is a word character.
    if (/role="alert"/.test(line) || /error/.test(t) || /conflict/.test(t)) return 'error';
    if (/coming soon|not supported|unsupported|unavailable/.test(t)) return 'unsupported';
    if (/select an? |open a |enter a url|requires |missing_binary|no instance/.test(t)) return 'prerequisite';
    if (/loading|aria-busy|skeleton|probing|resolving|preparing|truncated|limit reached|oversize/.test(t)) return 'loading';
    // `No {mode} changes` — the interpolation defeats `\bno \w`.
    if (/\bno [\w{]|empty|nothing|start of history/.test(t)) return 'empty';
    // The remaining branches render a runtime message (`{rootState.message}`,
    // `{terminal[0]}`), so no static axis can be honestly assigned. They still
    // count toward the denominator — they are state surfaces either way.
    return 'dynamic';
}

/** The primitive each branch should migrate to (§DS-4 routing). */
function targetOf(line, file) {
    if (/d2-(settings-field-error|schedule-field-error)/.test(line)) return 'FieldError';
    if (/role="alert"/.test(line) && !/placeholder|pane-empty|side-pane/.test(line)) return 'Alert';
    if (/skeleton/i.test(line)) return 'Skeleton';
    if (/inline-state|menu-state|tree-state|modal-empty|reminders-loading|notes-loading|browser-loading|settings-empty|lifecycle-message/.test(line)) return 'InlineState';
    if (/Menu|Palette|QuickSwitcher|Sidebar/.test(file) && /empty|no /i.test(line)) return 'InlineState';
    return 'StatePanel';
}

const branches = [];
for (const file of tsxFiles(SRC)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        const cls = line.match(/className=["'`{]([^"'`}]*)/);
        const isStateClass = cls && STATE_CLASS.test(cls[1]);
        const isLive = /role="(alert|status)"/.test(line);
        const isFallback = /fallback=\{?</.test(line);
        if (!isStateClass && !isLive && !isFallback) return;
        if (isNotVisualState(line)) return;
        // A container that only wraps real content is not a state branch.
        if (/<(section|header|ol|ul|li|div)\b/.test(line) && !isLive && !isFallback
            && /className=["'][^"']*"\s*(aria-label|data-phase|key)=/.test(line)) return;
        // Stop at the next branch. A fixed 3-line window bled the neighbouring
        // element's text in and inflated `error` from 52 to 66.
        const context = [];
        for (let k = i + 1; k < Math.min(i + 5, lines.length); k += 1) {
            const next = lines[k];
            if (/className=|role="(alert|status)"/.test(next)) break;
            context.push(next);
        }
        const ctx = context.join('\n');
        branches.push({
            file: rel,
            line: i + 1,
            axis: axisOf(line, ctx),
            target: targetOf(line, rel),
            snippet: line.trim().slice(0, 110),
        });
    });
}

const tally = (key) => branches.reduce((acc, b) => ({ ...acc, [b[key]]: (acc[b[key]] ?? 0) + 1 }), {});
const byFile = branches.reduce((acc, b) => ({ ...acc, [b.file]: (acc[b.file] ?? 0) + 1 }), {});

console.log(JSON.stringify({
    total: branches.length,
    byAxis: tally('axis'),
    byTarget: tally('target'),
    byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1])),
    branches,
}, null, 2));
