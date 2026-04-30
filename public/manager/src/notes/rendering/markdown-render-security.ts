import { defaultSchema } from 'rehype-sanitize';
import type { Options as RehypeSanitizeSchema } from 'rehype-sanitize';

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isSafeExternalHref(url: string): boolean {
    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.origin === window.location.origin && !url.startsWith('file:')) return true;
        return SAFE_SCHEMES.has(parsed.protocol);
    } catch {
        return false;
    }
}

export function safeMarkdownUrl(url: string): string {
    return isSafeExternalHref(url) ? url : '';
}

// rehype-raw is intentionally absent: Notes render user-authored markdown only,
// and raw HTML must stay disabled before future WYSIWYG reuse.
export const markdownSanitizeSchema: RehypeSanitizeSchema = {
    ...defaultSchema,
    attributes: {
        ...defaultSchema.attributes,
        code: [
            ...(defaultSchema.attributes?.code ?? []),
            ['className', /^language-./, 'math-inline', 'math-display'],
        ],
    },
};
