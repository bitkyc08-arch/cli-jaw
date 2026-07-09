import { escapeHtml } from './html.js';

const DIFF_PATTERN = /^---\s+\S+\n\+\+\+\s+\S+\n@@\s/m;
const MAX_LINES = 800;

export function isUnifiedDiff(text: string): boolean {
    return DIFF_PATTERN.test(text.trim());
}

function lineClass(line: string): string {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'diff-file';
    if (line.startsWith('@@')) return 'diff-hunk';
    if (line.startsWith('+')) return 'diff-add';
    if (line.startsWith('-')) return 'diff-del';
    if (line.startsWith(' ')) return 'diff-ctx';
    return 'diff-meta';
}

function displayLineNumber(index: number, line: string): string {
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) return '';
    return String(index + 1);
}

export function renderDiffViewer(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const visible = lines.slice(0, MAX_LINES);
    const rows = visible.map((line, index) => {
        const klass = lineClass(line);
        const ln = displayLineNumber(index, line);
        return `<div class="diff-line ${klass}"><span class="diff-ln">${escapeHtml(ln)}</span><span class="diff-code">${escapeHtml(line || ' ')}</span></div>`;
    }).join('');
    const omitted = lines.length > MAX_LINES
        ? `<div class="diff-omitted">${lines.length - MAX_LINES} lines omitted</div>`
        : '';
    return `<div class="diff-viewer" role="region" aria-label="Diff viewer">${rows}${omitted}</div>`;
}

