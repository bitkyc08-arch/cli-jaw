import createDOMPurify from 'dompurify';

export type SanitizedHtml = string & { readonly __sanitizedHtml: unique symbol };
export type SanitizeProfile = 'markdown' | 'highlight' | 'katex' | 'mermaid-svg';

export const sanitizePolicyVersion = 'r3.0';

type Purifier = {
    sanitize(input: string, config?: Record<string, unknown>): string;
    addHook(name: string, callback: (node: Element) => void): void;
};

const SAFE_ABSOLUTE_URL = /^(?:https?:|mailto:)/i;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
let purifier: Purifier | null = null;
let purifierWindow: Window | null = null;
let activeProfile: SanitizeProfile = 'markdown';

const KATEX_STYLE_PROPERTIES = new Set([
    'margin-left', 'margin-right', 'padding-left', 'padding-right', 'top', 'bottom', 'height', 'width',
    'min-width', 'vertical-align', 'border-bottom-width', 'border-top-width', 'left', 'right',
]);
const KATEX_LENGTH = /^-?[0-9.]+(?:em|px)$/;
const KATEX_CALC = /^calc\(\s*-?[0-9.]+(?:em|px)(?:\s*[+-]\s*-?[0-9.]+(?:em|px))+\s*\)$/;
const MERMAID_STYLE_PROPERTIES = /^(?:fill|stroke(?:-[\w-]+)?|font(?:-[\w-]+)?|opacity|text-anchor|dominant-baseline|color)$/;
const MERMAID_SELECTOR = /^(?:#[\w-]+|\.[\w-]+)(?:[\s>+~,:.#\[\]="'-]+[\w-]+)*$/;
const LOCAL_URL_REFERENCE = /^url\(\s*#[\w:.-]+\s*\)$/i;
export function isValidKatexStyle(style: string): boolean {
    return style.split(';').filter(Boolean).every(declaration => {
        const separator = declaration.indexOf(':');
        if (separator < 1) return false;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        const value = declaration.slice(separator + 1).trim().toLowerCase();
        return KATEX_STYLE_PROPERTIES.has(property) && (KATEX_LENGTH.test(value) || KATEX_CALC.test(value));
    });
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function isSafeUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u0020\u007f]+/g, '');
    if (!normalized || normalized.startsWith('//')) return false;
    return !EXPLICIT_SCHEME.test(normalized) || SAFE_ABSOLUTE_URL.test(normalized);
}

export function sanitizeMermaidStyle(css: string): string {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
        const selectors = match[1].split(',').map(value => value.trim());
        if (!selectors.length || selectors.some(selector => !MERMAID_SELECTOR.test(selector))) return [];
        const declarations = match[2].split(';').map(value => value.trim()).filter(Boolean).flatMap((declaration) => {
            const separator = declaration.indexOf(':');
            if (separator < 1) return [];
            const property = declaration.slice(0, separator).trim().toLowerCase();
            const value = declaration.slice(separator + 1).trim();
            if (!MERMAID_STYLE_PROPERTIES.test(property) || /(?:expression|javascript:|@import)/i.test(value)) return [];
            if (/url\(/i.test(value) && !LOCAL_URL_REFERENCE.test(value)) return [];
            return [`${property}:${value}`];
        });
        return declarations.length ? [`${selectors.join(',')}{${declarations.join(';')}}`] : [];
    }).join('');
}

function getPurifier(win: Window): Purifier {
    if (purifier && purifierWindow === win) return purifier;
    const instance = (createDOMPurify as unknown as (target: Window) => Purifier)(win);
    instance.addHook('afterSanitizeAttributes', (node) => {
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            if ((name === 'style' && (activeProfile !== 'katex' || !isValidKatexStyle(attribute.value))) || name.startsWith('on')) node.removeAttribute(attribute.name);
            if ((name === 'href' || name === 'src' || name === 'xlink:href')
                && (activeProfile === 'mermaid-svg' ? !attribute.value.trim().startsWith('#') : !isSafeUrl(attribute.value))) {
                node.removeAttribute(attribute.name);
            }
            if (activeProfile === 'mermaid-svg' && /^(?:fill|stroke|marker-start|marker-mid|marker-end)$/.test(name)
                && /url\(/i.test(attribute.value) && !LOCAL_URL_REFERENCE.test(attribute.value)) node.removeAttribute(attribute.name);
        }
        if (activeProfile === 'mermaid-svg' && node.tagName.toLowerCase() === 'style') {
            node.textContent = sanitizeMermaidStyle(node.textContent ?? '');
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
        FORBID_ATTR: ['style'], ADD_ATTR: ['data-render-slot'], ALLOW_DATA_ATTR: false,
    },
    highlight: {
        ALLOWED_TAGS: ['pre', 'code', 'span', 'br'],
        ALLOWED_ATTR: ['class', 'data-language', 'data-syntax-token'], ALLOW_DATA_ATTR: false,
    },
    katex: {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class', 'aria-hidden', 'style'],
        ALLOW_DATA_ATTR: false,
    },
    'mermaid-svg': {
        ALLOWED_TAGS: ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'linearGradient', 'stop', 'title', 'desc', 'style', 'use'],
        ALLOWED_ATTR: ['xmlns', 'viewBox', 'preserveAspectRatio', 'transform', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'offset', 'stop-color', 'stop-opacity', 'class', 'id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'href', 'xlink:href'],
        FORBID_TAGS: ['foreignObject', 'script', 'animate', 'animateMotion', 'animateTransform', 'set', 'a', 'image'],
        ALLOW_DATA_ATTR: false,
    },
};

function filterProfileClasses(html: string, profile: SanitizeProfile): string {
    if (profile === 'markdown' || profile === 'mermaid-svg') return html;
    const highlightClass = /^(?:language-[a-z0-9-]+|token\s+(?:keyword|syntax-(?:foreground|comment|keyword|string|number|type|function|operator|punctuation|insert|delete)))$/;
    const katexClass = /^(?:katex(?:-[\w-]+)?|mord|mrel|mopen|mclose|mbin|mpunct|mspace|mop|msupsub|mathnormal|base|strut|vlist(?:-[a-z]+)?|fontsize-ensurer|sizing|reset-size\d+|size\d+|mtight|pstrut|frac-line|svg-align|hide-tail|accent-body|delimsizing|nulldelimiter)$/;
    return html.replace(/\sclass="([^"]*)"/g, (whole, classes: string) =>
        (profile === 'highlight' ? highlightClass.test(classes.trim()) : classes.trim().split(/\s+/).every(name => katexClass.test(name))) ? whole : '');
}

export function sanitizeHtml(unsafeHtml: string, profile: SanitizeProfile): SanitizedHtml {
    if (typeof window === 'undefined') return escapeHtml(unsafeHtml) as SanitizedHtml;
    activeProfile = profile;
    const clean = getPurifier(window).sanitize(unsafeHtml, PROFILE_CONFIG[profile]);
    activeProfile = 'markdown';
    return filterProfileClasses(clean, profile) as SanitizedHtml;
}

export function sanitizedHtmlProps(html: SanitizedHtml): { __html: string } {
    return { __html: html };
}
