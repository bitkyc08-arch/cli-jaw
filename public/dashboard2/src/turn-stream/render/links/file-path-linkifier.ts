export interface PathHit { start: number; end: number; path: string; kind: 'absolute' | 'relative' }

const ABSOLUTE_RE = /(?:~\/|\/(?:Users|home|tmp|var|opt|private)\/)[^\s)`\]"'<>]+/g;
const RELATIVE_RE = /(?:\.\.?\/[^\s)`\]"'<>]+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,12})/g;
const TRAILING = /[.,!?:;]+$/;

export function collectPathHits(text: string): PathHit[] {
    const candidates: PathHit[] = [];
    for (const [regex, kind] of [[ABSOLUTE_RE, 'absolute'], [RELATIVE_RE, 'relative']] as const) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text))) {
            if (/^https?:\/\//i.test(match[0])) continue;
            if (/https?:\/\/[^\s]*$/i.test(text.slice(0, match.index))) continue;
            const path = match[0].replace(TRAILING, '');
            if (!path || /^\d{1,4}\/\d{1,2}\/\d{1,4}(?:\.|$)/.test(path) || /^\d+\/\d+$/.test(path)) continue;
            candidates.push({ start: match.index, end: match.index + path.length, path, kind });
        }
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: PathHit[] = [];
    for (const hit of candidates) if (!merged.length || hit.start >= merged[merged.length - 1].end) merged.push(hit);
    return merged;
}

const SKIP = 'pre,a,button,textarea,input,script,style,[data-render-slot],[data-file-link]';

export function linkifyFilePaths(host: HTMLElement): void {
    // numeric constants: SHOW_TEXT=4, FILTER_ACCEPT=1, FILTER_REJECT=2 — the
    // NodeFilter global is absent in some jsdom test setups
    const doc = host.ownerDocument;
    const walker = doc.createTreeWalker(host, 4, { acceptNode(node) {
        const parent = node.parentElement;
        return parent?.closest(SKIP) ? 2 : 1;
    } });
    const work: Array<[Text, PathHit[]]> = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) { const hits = collectPathHits(node.data); if (hits.length) work.push([node, hits]); }
    for (const [textNode, hits] of work) {
        const fragment = document.createDocumentFragment(); let cursor = 0;
        for (const hit of hits) {
            fragment.append(textNode.data.slice(cursor, hit.start));
            const span = document.createElement('span');
            span.dataset['fileLink'] = hit.path; span.setAttribute('role', 'button'); span.tabIndex = 0;
            span.title = hit.path; span.setAttribute('aria-label', hit.path); span.textContent = hit.path.split('/').pop() || hit.path;
            fragment.append(span); cursor = hit.end;
        }
        fragment.append(textNode.data.slice(cursor)); textNode.replaceWith(fragment);
    }
}

export function teardownFilePathLinks(host: HTMLElement): void {
    for (const link of host.querySelectorAll<HTMLElement>('[data-file-link]')) link.replaceWith(document.createTextNode(link.dataset['fileLink'] ?? link.textContent ?? ''));
    host.normalize();
}
