import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { posix } from 'node:path';
import type { Link, Root, Text } from 'mdast';
import type { NoteLinkRef } from '../types.js';
import { NOTE_FILE_EXT } from '../../notes/path-guards.js';

const markdownProcessor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml']);

type LineColumn = {
    line: number;
    column: number;
};

type ParsedMarkdownLinkTarget = {
    target: string;
    heading?: string;
};

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WIKI_OPEN = '[[';
const WIKI_OPEN_MARKDOWN_ESCAPED = '\\[\\[';
const WIKI_CLOSE = ']]';
const WIKI_CLOSE_MARKDOWN_ESCAPED = '\\]\\]';

function lineStarts(source: string): number[] {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') starts.push(index + 1);
    }
    return starts;
}

function offsetToLineColumn(starts: number[], offset: number): LineColumn {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const start = starts[mid] ?? 0;
        if (start <= offset) low = mid + 1;
        else high = mid - 1;
    }
    const lineIndex = Math.max(0, high);
    const start = starts[lineIndex] ?? 0;
    return {
        line: lineIndex + 1,
        column: offset - start + 1,
    };
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function firstUnescaped(text: string, char: string): number {
    for (let index = 0; index < text.length; index++) {
        if (text[index] === char && !isEscaped(text, index)) return index;
    }
    return -1;
}

function parseInner(inner: string): { target: string; displayText?: string; heading?: string } {
    const pipe = firstUnescaped(inner, '|');
    const targetPart = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const displayPart = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
    const headingIndex = firstUnescaped(targetPart, '#');
    const target = (headingIndex === -1 ? targetPart : targetPart.slice(0, headingIndex)).trim();
    const heading = headingIndex === -1 ? '' : targetPart.slice(headingIndex + 1).trim();
    return {
        target,
        ...(displayPart ? { displayText: displayPart } : {}),
        ...(heading ? { heading } : {}),
    };
}

function earliestMatch(text: string, cursor: number, patterns: readonly string[]): { index: number; pattern: string } | null {
    let best: { index: number; pattern: string } | null = null;
    for (const pattern of patterns) {
        const index = text.indexOf(pattern, cursor);
        if (index === -1) continue;
        if (!best || index < best.index) best = { index, pattern };
    }
    return best;
}

function safeDecodePath(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function noteLikeMarkdownPath(path: string): boolean {
    const ext = posix.extname(path).toLowerCase();
    return ext === '' || ext === NOTE_FILE_EXT;
}

function parseMarkdownLinkTarget(sourcePath: string, url: string): ParsedMarkdownLinkTarget | null {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/')) {
        return null;
    }
    if (URL_SCHEME_RE.test(trimmed)) return null;

    const withoutQuery = trimmed.split('?')[0] || '';
    const hashIndex = firstUnescaped(withoutQuery, '#');
    const rawPath = (hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex)).trim();
    const heading = hashIndex === -1 ? '' : withoutQuery.slice(hashIndex + 1).trim();
    if (!rawPath) return null;

    const decodedPath = safeDecodePath(rawPath);
    if (!noteLikeMarkdownPath(decodedPath)) return null;

    const sourceDir = posix.dirname(sourcePath);
    const normalized = posix.normalize(posix.join(sourceDir === '.' ? '' : sourceDir, decodedPath));
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;

    return {
        target: normalized,
        ...(heading ? { heading: safeDecodePath(heading) } : {}),
    };
}

function textFromLink(node: Link): string {
    const parts: string[] = [];
    visit(node, 'text', (child: Text) => {
        parts.push(child.value);
    });
    return parts.join('').trim();
}

function scanTextNode(
    sourcePath: string,
    text: string,
    absoluteStart: number,
    starts: number[],
): NoteLinkRef[] {
    const refs: NoteLinkRef[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        const openMatch = earliestMatch(text, cursor, [WIKI_OPEN, WIKI_OPEN_MARKDOWN_ESCAPED]);
        if (!openMatch) break;
        const open = openMatch.index;
        if (openMatch.pattern === WIKI_OPEN && isEscaped(text, open)) {
            cursor = open + WIKI_OPEN.length;
            continue;
        }
        const innerStart = open + openMatch.pattern.length;
        const closeMatch = earliestMatch(text, innerStart, [WIKI_CLOSE, WIKI_CLOSE_MARKDOWN_ESCAPED]);
        if (!closeMatch) break;
        const close = closeMatch.index;
        const startOffset = absoluteStart + open;
        const endOffset = absoluteStart + close + closeMatch.pattern.length;
        const parsed = parseInner(text.slice(innerStart, close));
        const position = offsetToLineColumn(starts, startOffset);
        refs.push({
            sourcePath,
            raw: text.slice(open, close + closeMatch.pattern.length),
            target: parsed.target,
            ...(parsed.displayText ? { displayText: parsed.displayText } : {}),
            ...(parsed.heading ? { heading: parsed.heading } : {}),
            line: position.line,
            column: position.column,
            startOffset,
            endOffset,
            status: 'missing',
            reason: 'not_found',
        });
        cursor = close + closeMatch.pattern.length;
    }
    return refs;
}

export function extractWikiLinks(sourcePath: string, markdown: string): NoteLinkRef[] {
    const tree = markdownProcessor.parse(markdown) as Root;
    const starts = lineStarts(markdown);
    const refs: NoteLinkRef[] = [];
    visit(tree, 'text', (node: Text) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        refs.push(...scanTextNode(sourcePath, markdown.slice(start, end), start, starts));
    });
    visit(tree, 'link', (node: Link) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const parsed = parseMarkdownLinkTarget(sourcePath, node.url);
        if (!parsed) return;
        const displayText = textFromLink(node);
        const position = offsetToLineColumn(starts, start);
        refs.push({
            sourcePath,
            raw: markdown.slice(start, end),
            target: parsed.target,
            ...(displayText ? { displayText } : {}),
            ...(parsed.heading ? { heading: parsed.heading } : {}),
            line: position.line,
            column: position.column,
            startOffset: start,
            endOffset: end,
            status: 'missing',
            reason: 'not_found',
        });
    });
    return refs;
}
