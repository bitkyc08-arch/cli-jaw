import createDOMPurify from 'dompurify';

export type DOMPurifyLike = {
    sanitize(input: string, config?: Record<string, unknown>): string;
    addHook(name: string, callback: (node: Element) => void): void;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_HREF_ALLOWED = new Set(['a', 'area', 'link']);
const URL_CAPABLE_ATTRS = [
    'fill', 'stroke', 'filter', 'mask', 'clip-path',
    'marker-start', 'marker-mid', 'marker-end', 'cursor',
];

let purifySingleton: DOMPurifyLike | null = null;

function createPurifyInstance(): DOMPurifyLike {
    const purify = createDOMPurify as unknown as Partial<DOMPurifyLike> &
        ((win?: Window) => DOMPurifyLike);
    if (typeof purify.sanitize === 'function' && typeof purify.addHook === 'function') {
        return purify as DOMPurifyLike;
    }
    if (typeof window !== 'undefined') return purify(window);
    return {
        sanitize: (input: string) => input,
        addHook: () => undefined,
    };
}

function registerAttributeHook(purify: DOMPurifyLike): void {
    purify.addHook('afterSanitizeAttributes', (node) => {
        const tag = node.tagName.toLowerCase();

        const isSvgElement = node.namespaceURI === SVG_NS;
        if (isSvgElement || !HTML_HREF_ALLOWED.has(tag)) {
            const href = node.getAttribute('href') || '';
            if (href && !href.startsWith('#')) {
                node.removeAttribute('href');
            }
        }

        const xlinkHref = node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
            || node.getAttribute('xlink:href') || '';
        if (xlinkHref && !xlinkHref.startsWith('#')) {
            node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
            node.removeAttribute('xlink:href');
        }

        if (tag === 'image' || tag === 'feimage') {
            const src = node.getAttribute('src') || '';
            if (src && !src.startsWith('#')) {
                node.removeAttribute('src');
            }
        }

        if (node.hasAttribute('style')) {
            const cssText = (node as HTMLElement).style?.cssText || '';
            if (/url\s*\(/i.test(cssText)) {
                const cleaned = cssText.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
                (node as HTMLElement).style.cssText = cleaned;
            }
        }
        for (const attr of URL_CAPABLE_ATTRS) {
            if (!node.hasAttribute(attr)) continue;
            const val = node.getAttribute(attr) || '';
            if (/url\s*\(/i.test(val)) {
                const cleaned = val.replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
                node.setAttribute(attr, cleaned);
            }
        }
    });
}

export function getDOMPurify(): DOMPurifyLike {
    if (purifySingleton) return purifySingleton;
    purifySingleton = createPurifyInstance();
    registerAttributeHook(purifySingleton);
    return purifySingleton;
}
