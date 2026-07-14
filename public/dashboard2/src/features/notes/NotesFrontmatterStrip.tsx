import type { JSX } from 'react';
import { splitPreviewFrontmatter } from './frontmatter-preview';

export type NotesFrontmatterStripProps = { content: string };

function extractTags(frontmatter: string): string[] {
    const lines = frontmatter.replace(/^---\s*\r?\n/u, '').replace(/\r?\n---\s*$/u, '').split(/\r?\n/u);
    const tagsLine = lines.find(line => /^tags\s*:/iu.test(line));
    if (!tagsLine) return [];

    const value = tagsLine.replace(/^tags\s*:\s*/iu, '').trim();
    if (!value) return [];
    return value
        .replace(/^\[|\]$/gu, '')
        .split(',')
        .map(tag => tag.trim().replace(/^['"]|['"]$/gu, '').replace(/^#/u, ''))
        .filter(Boolean);
}

export function NotesFrontmatterStrip({ content }: NotesFrontmatterStripProps): JSX.Element | null {
    if (!content.startsWith('---')) return null;
    const { frontmatterRaw } = splitPreviewFrontmatter(content);
    if (!frontmatterRaw) return null;

    const tags = extractTags(frontmatterRaw);
    if (tags.length === 0) return null;

    return (
        <div className="d2-notes-frontmatter-strip" aria-label="Note tags">
            {tags.map(tag => <span className="d2-notes-tag-pill" key={tag}>#{tag}</span>)}
        </div>
    );
}
