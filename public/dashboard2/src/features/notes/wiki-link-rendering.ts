import { Children, createElement, isValidElement, type MouseEvent, type ReactNode } from 'react';
import type { NoteLinkRef, NoteMetadata } from './notes-types';
import {
    buildOutgoingWikiLinkLookup,
    isEscaped,
    resolveClientWikiLink,
    WIKI_LINK_RE,
    wikiLinkDisplayText,
    wikiLinkReasonLabel,
    type ClientWikiLinkResolution,
} from './wiki-link-resolver';

export {
    firstUnescaped,
    invalidWikiLinkTarget,
    isEscaped,
    parseWikiLinkToken,
    WIKI_LINK_RE,
    wikiLinkDisplayText,
    wikiLinkReasonLabel,
    type ClientWikiLinkResolution,
    type ParsedWikiLinkToken,
} from './wiki-link-resolver';

type RenderableWikiLink = NoteLinkRef | ClientWikiLinkResolution;

export function buildWikiLinkLookup(
    outgoing: readonly NoteLinkRef[] | undefined | null,
): Map<string, ClientWikiLinkResolution> {
    return buildOutgoingWikiLinkLookup(outgoing);
}

export type WikiLinkContext = {
    lookup: Map<string, RenderableWikiLink>;
    outgoing?: readonly NoteLinkRef[] | undefined;
    notes?: readonly NoteMetadata[] | undefined;
    onNavigate: (path: string) => void;
};

function transformString(text: string, ctx: WikiLinkContext, keyPrefix: string): ReactNode[] {
    if (!text) return [text];
    const hasFallback = Boolean(ctx.notes?.length);
    if (ctx.lookup.size === 0 && !hasFallback) return [text];
    WIKI_LINK_RE.lastIndex = 0;
    const result: ReactNode[] = [];
    let cursor = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_RE.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (isEscaped(text, start)) continue;
        const link = ctx.lookup.get(match[0]) ?? resolveClientWikiLink(match[0], ctx.outgoing, ctx.notes, start);
        if (!link) continue;
        if (start > cursor) result.push(text.slice(cursor, start));
        const display = wikiLinkDisplayText(link, match[0]);
        const key = `${keyPrefix}-wl-${index++}`;
        if (link.status === 'resolved' && link.resolvedPath) {
            const target = link.resolvedPath;
            result.push(
                createElement(
                    'a',
                    {
                        key,
                        className: 'notes-wikilink',
                        href: `#${encodeURIComponent(target)}`,
                        title: target,
                        'data-notes-wiki-status': link.status,
                        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
                            event.preventDefault();
                            ctx.onNavigate(target);
                        },
                    },
                    display,
                ),
            );
        } else {
            const reasonLabel = wikiLinkReasonLabel(link);
            result.push(
                createElement(
                    'span',
                    {
                        key,
                        className: 'notes-wikilink is-broken',
                        title: reasonLabel,
                        'data-notes-wiki-status': link.status,
                        'aria-label': `Broken wikilink: ${match[1]}`,
                    },
                    display,
                ),
            );
        }
        cursor = end;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) result.push(text.slice(cursor));
    return result;
}

export function splitTextWithWikiLinks(
    text: string,
    lookup: Map<string, RenderableWikiLink>,
    onNavigate: (path: string) => void,
): ReactNode[] {
    return transformString(text, { lookup, onNavigate }, 'text');
}

export function splitChildrenWithWikiLinks(children: ReactNode, ctx: WikiLinkContext, keyPrefix: string): ReactNode {
    if (ctx.lookup.size === 0 && !ctx.notes?.length) return children;
    const out: ReactNode[] = [];
    let stringIndex = 0;
    Children.forEach(children, (child, i) => {
        if (typeof child === 'string') {
            const segments = transformString(child, ctx, `${keyPrefix}-${stringIndex++}-${i}`);
            for (const seg of segments) out.push(seg);
            return;
        }
        if (typeof child === 'number' || typeof child === 'boolean' || child === null || child === undefined) {
            out.push(child);
            return;
        }
        if (isValidElement(child)) {
            out.push(child);
            return;
        }
        out.push(child);
    });
    return out;
}
