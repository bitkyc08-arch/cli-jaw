import { extname, isAbsolute } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Image, Root } from 'mdast';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_RELAY_IMAGES = 4;
const markdownProcessor = unified().use(remarkParse);

function isExternalImageTarget(target: string): boolean {
    return /^https?:/i.test(target)
        || /^data:/i.test(target)
        || target.startsWith('//');
}

export function extractLocalImagePaths(markdown: string): string[] {
    if (!markdown) return [];

    const tree = markdownProcessor.parse(markdown) as Root;
    const paths: string[] = [];
    const seen = new Set<string>();

    visit(tree, 'image', (node: Image) => {
        if (paths.length >= MAX_RELAY_IMAGES) return;
        const target = String(node.url || '').trim();
        if (!target || isExternalImageTarget(target) || !isAbsolute(target)) return;
        if (target.startsWith('/media/') || target.startsWith('/api/')) return;
        if (!IMAGE_EXTENSIONS.has(extname(target).toLowerCase())) return;
        if (seen.has(target)) return;
        seen.add(target);
        paths.push(target);
    });

    return paths;
}
