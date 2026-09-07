/**
 * Unified-diff → ANSI colorizer.
 * Colors raw `git diff` text with theme tokens; truncates long diffs.
 * No new dependency — the diff text comes from the existing git path
 * (src/ide/diff.ts getUnifiedDiff). Pure + synchronous + theme-aware.
 */
import { paint } from './theme.js';

function colorizeDiffLine(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---')) return paint('text.muted', line);
    if (line.startsWith('@@')) return paint('accent', line);
    if (line.startsWith('diff ') || line.startsWith('index ')
        || line.startsWith('new file') || line.startsWith('deleted file')
        || line.startsWith('rename ') || line.startsWith('similarity ')) {
        return paint('text.muted', line);
    }
    if (line.startsWith('+')) return paint('diff.add', line);
    if (line.startsWith('-')) return paint('diff.del', line);
    return paint('text.muted', line); // context line — dimmed
}

/**
 * Colorize a unified diff, truncating to `maxLines` body lines.
 * `gutter` is prepended to every line. Returns '' for empty input.
 */
export function colorizeDiff(raw: string, opts?: { maxLines?: number; gutter?: string }): string {
    const text = raw.replace(/\n+$/, '');
    if (!text) return '';
    const maxLines = opts?.maxLines ?? 60;
    const gutter = opts?.gutter ?? '  ';
    const lines = text.split('\n');
    const shown = lines.slice(0, maxLines).map(l => gutter + colorizeDiffLine(l));
    if (lines.length > maxLines) {
        shown.push(gutter + paint('text.muted', `… +${lines.length - maxLines} more lines`));
    }
    return shown.join('\n');
}
