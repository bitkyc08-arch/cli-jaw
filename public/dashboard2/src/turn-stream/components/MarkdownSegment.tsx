import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useMemo, type ReactElement } from 'react';

export interface MarkdownSegmentProps {
    text: string;
    streaming?: boolean;
}

type Purifier = {
    sanitize(input: string, config?: Record<string, unknown>): string;
    addHook(name: string, callback: (node: Element) => void): void;
};

let purifier: Purifier | null = null;
let purifierWindow: Window | null = null;

const URL_ATTRIBUTES = ['href', 'src'] as const;
const SAFE_ABSOLUTE_URL = /^(?:https?:|mailto:)/i;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isSafeUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u0020\u007f]+/g, '');
    if (!normalized || normalized.startsWith('//')) return false;
    if (!EXPLICIT_SCHEME.test(normalized)) return true;
    return SAFE_ABSOLUTE_URL.test(normalized);
}

function createPurifier(win: Window): Purifier {
    const instance = (createDOMPurify as unknown as (value: Window) => Purifier)(win);
    instance.addHook('afterSanitizeAttributes', (node) => {
        for (const attribute of Array.from(node.attributes)) {
            if (/^on/i.test(attribute.name) || attribute.name.toLowerCase() === 'style') {
                node.removeAttribute(attribute.name);
            }
        }
        for (const attribute of URL_ATTRIBUTES) {
            const value = node.getAttribute(attribute);
            if (value !== null && !isSafeUrl(value)) node.removeAttribute(attribute);
        }
    });
    return instance;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function sanitizeMarkdown(text: string): string {
    const html = marked.parse(text, { async: false });
    if (typeof window === 'undefined') return escapeHtml(html);
    if (!purifier || purifierWindow !== window) {
        purifier = createPurifier(window);
        purifierWindow = window;
    }
    return purifier.sanitize(html, {
        ALLOW_UNKNOWN_PROTOCOLS: false,
        FORBID_TAGS: ['script', 'iframe'],
        FORBID_ATTR: ['style'],
    });
}

export const MarkdownSegment = memo(function MarkdownSegment({
    text,
    streaming = false,
}: MarkdownSegmentProps): ReactElement {
    const html = useMemo(
        () => streaming ? null : sanitizeMarkdown(text),
        [streaming, text],
    );
    if (streaming) return <pre className="markdown-segment markdown-segment--streaming">{text}</pre>;
    return <div className="markdown-segment" dangerouslySetInnerHTML={{ __html: html ?? '' }} />;
});
