import createDOMPurify from 'dompurify';

export type SanitizedHtml = string & { readonly __sanitizedHtml: unique symbol };
export type SanitizeProfile = 'markdown' | 'highlight' | 'katex';

export const sanitizePolicyVersion = 'r1.1';

type Purifier = {
    sanitize(input: string, config?: Record<string, unknown>): string;
    addHook(name: string, callback: (node: Element) => void): void;
};

const SAFE_ABSOLUTE_URL = /^(?:https?:|mailto:)/i;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
let purifier: Purifier | null = null;
let purifierWindow: Window | null = null;

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function isSafeUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u0020\u007f]+/g, '');
    if (!normalized || normalized.startsWith('//')) return false;
    return !EXPLICIT_SCHEME.test(normalized) || SAFE_ABSOLUTE_URL.test(normalized);
}

function getPurifier(win: Window): Purifier {
    if (purifier && purifierWindow === win) return purifier;
    const instance = (createDOMPurify as unknown as (target: Window) => Purifier)(win);
    instance.addHook('afterSanitizeAttributes', (node) => {
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name === 'style' || name.startsWith('on')) node.removeAttribute(attribute.name);
            if ((name === 'href' || name === 'src') && !isSafeUrl(attribute.value)) {
                node.removeAttribute(attribute.name);
            }
        }
    });
    purifier = instance;
    purifierWindow = win;
    return instance;
}

const PROFILE_CONFIG: Record<SanitizeProfile, Record<string, unknown>> = {
    markdown: {
        ALLOW_UNKNOWN_PROTOCOLS: false,
        FORBID_TAGS: ['script', 'iframe', 'style', 'svg', 'math'],
        FORBID_ATTR: ['style'],
    },
    highlight: {
        ALLOWED_TAGS: ['pre', 'code', 'span'],
        ALLOWED_ATTR: ['class', 'data-language', 'data-syntax-token'],
        ALLOW_DATA_ATTR: true,
    },
    katex: {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class', 'aria-hidden'],
        ALLOW_DATA_ATTR: false,
    },
};

function filterProfileClasses(html: string, profile: SanitizeProfile): string {
    if (profile === 'markdown') return html;
    const allowed = profile === 'highlight'
        ? /^(?:language-[\w-]+|token(?:\s+[\w-]+)*)$/
        : /^(?:katex(?:-[\w-]+)?|mord|mrel|mopen|mclose|mbin|mpunct|mspace|mathnormal|base|strut)(?:\s+(?:[\w-]+))*$/;
    return html.replace(/\sclass="([^"]*)"/g, (whole, classes: string) =>
        allowed.test(classes.trim()) ? whole : '');
}

export function sanitizeHtml(unsafeHtml: string, profile: SanitizeProfile): SanitizedHtml {
    if (typeof window === 'undefined') return escapeHtml(unsafeHtml) as SanitizedHtml;
    const clean = getPurifier(window).sanitize(unsafeHtml, PROFILE_CONFIG[profile]);
    return filterProfileClasses(clean, profile) as SanitizedHtml;
}

export function sanitizedHtmlProps(html: SanitizedHtml): { __html: string } {
    return { __html: html };
}
