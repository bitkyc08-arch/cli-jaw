export type PreviewFrontmatterSplit = { frontmatterRaw: string | null; body: string };

const LEADING_FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitPreviewFrontmatter(markdown: string): PreviewFrontmatterSplit {
    const match = LEADING_FRONTMATTER_RE.exec(markdown);
    if (!match) return { frontmatterRaw: null, body: markdown };
    const frontmatterRaw = match[0];
    return { frontmatterRaw, body: markdown.slice(frontmatterRaw.length) };
}
