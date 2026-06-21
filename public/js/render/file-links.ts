// ── File path linkification and click-to-open delegation ──
import { apiJson } from '../api.js';
import {
    postPreviewOpenNotes,
    postPreviewOpenDoc,
    previewParentOrigin,
    parentSupportsDocPanel,
    waitForDocPanelCapability,
    ensurePreviewCapabilityListener,
} from '../preview-parent-origin.js';
import { normalizeNotesVaultPath } from './notes-vault-path.js';

const FILE_PATH_RE_G = /(?:~\/[^\s)`\]"'<>]+|\/(?:Users|home|tmp|var|opt|private)\/[^\s)`\]"'<>]+)/g;
const REL_NOTE_PATH_RE_G = /(?:^|[\s([{"'`])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md)\b/g;
const TRAILING_PUNCT_RE = /[.,!?:;]+$/;
const LOCAL_FILE_HREF_RE = /^(?:~\/|\/(?:Users|home|tmp|var|opt|private)\/)/;
// Mirrors DocPanel EXT_LANG keys exactly (drift guarded by tests/unit/preview-doc-links.test.ts).
const DOC_PANEL_CODE_RE = /\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|css|html|xml|json|yaml|yml|sh|bash|sql)$/i;
const DOC_PANEL_MARKDOWN_RE = /\.(md|mdx)$/i;

let notesRootCache: string | null | undefined;
let notesRootFetch: Promise<string | null> | null = null;

function isLocalFileHref(href: string): boolean {
    return LOCAL_FILE_HREF_RE.test(href);
}

function localPathFromAnchorHref(href: string): string | null {
    if (isLocalFileHref(href)) return href;
    try {
        const parsed = new URL(href, window.location.href);
        if (parsed.origin !== window.location.origin || parsed.pathname !== '/api/file/open') return null;
        const path = parsed.searchParams.get('path') ?? '';
        return isLocalFileHref(path) ? path : null;
    } catch {
        return null;
    }
}

function isExternalHttpHref(href: string): boolean {
    try {
        const parsed = new URL(href, window.location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        if (parsed.username || parsed.password) return false;
        return parsed.origin !== window.location.origin;
    } catch {
        return false;
    }
}

function ensureExternalAnchorTarget(anchor: HTMLAnchorElement): void {
    anchor.target = '_blank';
    const rel = new Set(anchor.rel.split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    anchor.rel = [...rel].join(' ');
}

async function resolveNotesRoot(): Promise<string | null> {
    if (notesRootCache !== undefined) return notesRootCache;
    if (!previewParentOrigin()) {
        notesRootCache = null;
        return null;
    }
    if (!notesRootFetch) {
        notesRootFetch = apiJson<{ root?: string }>('/api/dashboard/notes/info', 'GET', null)
            .then(data => (typeof data?.root === 'string' ? data.root : null))
            .catch(() => null)
            .then(root => {
                notesRootCache = root;
                return root;
            });
    }
    return notesRootFetch;
}

function openLocalPath(path: string, el?: HTMLElement | null): void {
    if (el) el.classList.add('opening');

    apiJson<{ ok?: boolean; error?: string }>('/api/file/open', 'POST', { path })
        .then(data => {
            el?.classList.remove('opening');
            if (data?.ok !== false) {
                el?.classList.add('opened');
                setTimeout(() => el?.classList.remove('opened'), 1500);
            } else {
                el?.classList.add('open-failed');
                if (el) el.title = data?.error || 'Failed to open';
                setTimeout(() => {
                    el?.classList.remove('open-failed');
                    if (el) el.title = '';
                }, 2000);
            }
        })
        .catch(() => {
            el?.classList.remove('opening');
            el?.classList.add('open-failed');
            setTimeout(() => el?.classList.remove('open-failed'), 2000);
        });
}

function appendFileLink(
    frag: DocumentFragment,
    clean: string,
    vaultRel: string | null,
): void {
    const span = document.createElement('span');
    span.className = 'file-path-link';
    span.setAttribute('data-file-path', clean);
    if (vaultRel) span.setAttribute('data-vault-rel', vaultRel);
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    const basename = clean.split('/').pop() || clean;
    const hasExt = /\.\w{1,10}$/.test(basename);
    span.textContent = hasExt ? basename : clean;
    if (hasExt) span.title = clean;
    frag.appendChild(span);
}

function collectAbsoluteHits(text: string): { index: number; raw: string; clean: string }[] {
    FILE_PATH_RE_G.lastIndex = 0;
    const hits: { index: number; raw: string; clean: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE_G.exec(text))) {
        const raw = match[0];
        const clean = raw.replace(TRAILING_PUNCT_RE, '');
        if (clean.length < 4) continue;
        hits.push({ index: match.index, raw, clean });
    }
    return hits;
}

function collectRelativeNoteHits(text: string): { index: number; raw: string; clean: string }[] {
    REL_NOTE_PATH_RE_G.lastIndex = 0;
    const hits: { index: number; raw: string; clean: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = REL_NOTE_PATH_RE_G.exec(text))) {
        const prefix = match[0].slice(0, match[0].length - match[1].length);
        const clean = match[1];
        const index = match.index + prefix.length;
        hits.push({ index, raw: clean, clean });
    }
    return hits;
}

function mergeHits(
    absoluteHits: { index: number; raw: string; clean: string }[],
    relativeHits: { index: number; raw: string; clean: string }[],
): { index: number; raw: string; clean: string }[] {
    const merged = [...absoluteHits, ...relativeHits].sort((a, b) => a.index - b.index);
    const filtered: { index: number; raw: string; clean: string }[] = [];
    let cursor = -1;
    for (const hit of merged) {
        if (hit.index < cursor) continue;
        filtered.push(hit);
        cursor = hit.index + hit.raw.length;
    }
    return filtered;
}

/**
 * Walk text nodes inside container, wrap file paths in clickable spans.
 */
export function linkifyFilePaths(container: HTMLElement, notesRoot: string | null = null): void {
    const SKIP_TAGS = new Set(['PRE', 'A', 'BUTTON', 'TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE']);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== container) {
                if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
                if (el.classList.contains('file-path-link')) return NodeFilter.FILTER_REJECT;
                if (el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE') {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodeMatches = new Map<Text, { index: number; raw: string; clean: string }[]>();
    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
        const text = textNode.textContent || '';
        const hits = mergeHits(collectAbsoluteHits(text), collectRelativeNoteHits(text));
        if (hits.length) nodeMatches.set(textNode, hits);
    }

    for (const [node, hits] of nodeMatches) {
        const text = node.textContent || '';
        const parent = node.parentNode;
        if (!parent) continue;

        const frag = document.createDocumentFragment();
        let cursor = 0;

        for (const { index, raw, clean } of hits) {
            if (index > cursor) {
                frag.appendChild(document.createTextNode(text.slice(cursor, index)));
            }
            const vaultRel = normalizeNotesVaultPath(clean, notesRoot);
            appendFileLink(frag, clean, vaultRel);
            const trailingPunct = raw.slice(clean.length);
            if (trailingPunct) frag.appendChild(document.createTextNode(trailingPunct));
            cursor = index + raw.length;
        }

        if (cursor < text.length) {
            frag.appendChild(document.createTextNode(text.slice(cursor)));
        }

        parent.replaceChild(frag, node);
    }
}

export async function linkifyFilePathsWithNotesRoot(container: HTMLElement): Promise<void> {
    const notesRoot = await resolveNotesRoot();
    linkifyFilePaths(container, notesRoot);
}

async function handleFilePathClick(path: string, link: HTMLElement): Promise<void> {
    const notesRoot = await resolveNotesRoot();
    const vaultRel = link.getAttribute('data-vault-rel')
        || normalizeNotesVaultPath(path, notesRoot);
    if (vaultRel && previewParentOrigin() && postPreviewOpenNotes(vaultRel)) {
        link.classList.add('opened');
        setTimeout(() => link.classList.remove('opened'), 1500);
        return;
    }
    const docPanelCandidate = DOC_PANEL_MARKDOWN_RE.test(path) || DOC_PANEL_CODE_RE.test(path);
    // DocPanel-capable Electron parents may announce capability after the
    // iframe click handler mounts; wait briefly before falling back to Finder.
    if (
        docPanelCandidate
        && (parentSupportsDocPanel() || await waitForDocPanelCapability())
        && previewParentOrigin()
        && postPreviewOpenDoc(path)
    ) {
        link.classList.add('opened');
        setTimeout(() => link.classList.remove('opened'), 1500);
        return;
    }
    openLocalPath(path, link);
}

let filePathDelegationReady = false;

export function ensureFilePathDelegation(): void {
    if (filePathDelegationReady) return;
    filePathDelegationReady = true;
    ensurePreviewCapabilityListener();

    // Message/chat surfaces may consume bubbling pointer events for selection.
    // Capture local-file activation before those handlers can swallow the click.
    document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const anchor = target?.closest('a') as HTMLAnchorElement | null;
        const href = anchor?.getAttribute('href') || '';
        if (anchor && isExternalHttpHref(href)) {
            ensureExternalAnchorTarget(anchor);
            return;
        }
        const localPath = anchor ? localPathFromAnchorHref(href) : null;
        if (anchor && localPath) {
            e.preventDefault();
            anchor.classList.add('file-path-link');
            void handleFilePathClick(localPath, anchor);
            return;
        }

        const link = target?.closest('.file-path-link') as HTMLElement | null;
        if (!link) return;

        const filePath = link.getAttribute('data-file-path');
        if (!filePath) return;
        e.preventDefault();
        void handleFilePathClick(filePath, link);
    }, true);

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = e.target as HTMLElement;
        if (target?.classList.contains('file-path-link')) {
            e.preventDefault();
            target.click();
        }
    }, true);
}
