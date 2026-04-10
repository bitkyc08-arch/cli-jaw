// ── Diagram Types & SVG Extraction ──
// Stack-based SVG parser + code-fence shielding for diagram rendering pipeline

export interface SvgBlock {
    id: number;
    index: number;
    length: number;
    svg: string;
    kind: 'complete' | 'partial' | 'error';
    placeholder: string;
}

let svgCounter = 0;

/** Reset counter (for testing) */
export function resetSvgCounter(): void { svgCounter = 0; }

/**
 * Pre-shield: wrap SVG inside fenced code blocks with NUL markers
 * so extractTopLevelSvg() skips them.
 * NUL chars are safe — un-shielded BEFORE marked/DOMPurify runs.
 *
 * Shields BOTH backtick (```) and tilde (~~~) fences.
 */
export function shieldCodeFenceSvg(text: string): { text: string; fences: Map<string, string> } {
    const fences = new Map<string, string>();
    const fenced = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (match) => {
        const key = `\x00FENCE-${svgCounter++}\x00`;
        fences.set(key, match);
        return key;
    });
    return { text: fenced, fences };
}

export function unshieldCodeFenceSvg(text: string, fences: Map<string, string>): string {
    for (const [key, val] of fences) {
        text = text.replace(key, val);
    }
    return text;
}

/**
 * Stack-based top-level SVG extractor.
 * Returns extracted blocks + text with placeholders.
 *
 * Placeholders use `<div data-jaw-svg="N">` — standard HTML block elements that:
 * - Survive marked.parse() (block-level HTML = type 6, never wrapped in <p>)
 * - Survive DOMPurify natively (<div> is allowed; data-* attrs via ADD_ATTR)
 * - Use \n\n wrapping to ensure paragraph boundary separation
 */
export function extractTopLevelSvg(text: string, isStreaming = false): { text: string; blocks: SvgBlock[] } {
    const blocks: SvgBlock[] = [];
    let result = '';
    let i = 0;

    while (i < text.length) {
        const openIdx = text.indexOf('<svg', i);
        if (openIdx === -1) {
            result += text.slice(i);
            break;
        }

        const charAfter = text[openIdx + 4];
        if (charAfter && !/[\s\/>]/.test(charAfter)) {
            result += text.slice(i, openIdx + 4);
            i = openIdx + 4;
            continue;
        }

        result += text.slice(i, openIdx);

        let depth = 0;
        let j = openIdx;
        let matched = false;

        while (j < text.length) {
            const nextOpen = text.indexOf('<svg', j + 1);
            const nextClose = text.indexOf('</svg>', j + (j === openIdx ? 0 : 1));

            if (nextClose === -1) break;

            if (nextOpen !== -1 && nextOpen < nextClose) {
                const afterOpen = text[nextOpen + 4];
                if (afterOpen && /[\s\/>]/.test(afterOpen)) {
                    depth++;
                }
                j = nextOpen + 4;
            } else {
                if (depth === 0) {
                    const endIdx = nextClose + '</svg>'.length;
                    const svgRaw = text.slice(openIdx, endIdx);
                    const id = svgCounter++;
                    const placeholder = `\n\n<div data-jaw-svg="${id}"></div>\n\n`;
                    blocks.push({ id, index: openIdx, length: svgRaw.length, svg: svgRaw, kind: 'complete', placeholder });
                    result += placeholder;
                    i = endIdx;
                    matched = true;
                    break;
                } else {
                    depth--;
                    j = nextClose + '</svg>'.length;
                }
            }
        }

        if (!matched) {
            const id = svgCounter++;
            if (isStreaming) {
                const svgPartial = text.slice(openIdx);
                const placeholder = `\n\n<div data-jaw-svg="${id}" data-jaw-kind="partial"></div>\n\n`;
                blocks.push({ id, index: openIdx, length: svgPartial.length, svg: '', kind: 'partial', placeholder });
                result += placeholder;
                i = text.length;
            } else {
                const placeholder = `\n\n<div data-jaw-svg="${id}" data-jaw-kind="error"></div>\n\n`;
                const restFromOpen = text.slice(openIdx);
                const blankLineIdx = restFromOpen.search(/\n\s*\n/);
                const consumeLen = blankLineIdx !== -1 ? blankLineIdx : restFromOpen.length;
                blocks.push({ id, index: openIdx, length: consumeLen, svg: '', kind: 'error', placeholder });
                result += placeholder;
                i = openIdx + consumeLen;
            }
        }
    }

    return { text: result, blocks };
}
