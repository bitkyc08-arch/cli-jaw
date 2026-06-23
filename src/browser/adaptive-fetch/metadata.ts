// Mirrored from agbrowse adaptive-fetch v2; keep runtime behavior aligned while cli-jaw mirror remains experimental.

import { extractTitleFromHtml, htmlToReadableText, normalizeWhitespace } from './transforms.js';

export function extractMetadataFromHtml(html: string = '', finalUrl: string = '') {
    const title = firstNonEmpty(
        getMetaContent(html, 'property', 'og:title'),
        getMetaContent(html, 'name', 'twitter:title'),
        extractTitleFromHtml(html),
    );
    const description = firstNonEmpty(
        getMetaContent(html, 'name', 'description'),
        getMetaContent(html, 'property', 'og:description'),
        getMetaContent(html, 'name', 'twitter:description'),
    );
    const canonicalUrl = resolveMaybeUrl(getLinkHref(html, 'canonical'), finalUrl);
    const feedUrls = extractFeedUrls(html, finalUrl);
    const oEmbedUrls = extractOembedUrls(html, finalUrl);
    const jsonLd = extractJsonLdBlocks(html);
    const openGraph = extractOpenGraph(html);
    const twitterCard = extractTwitterCard(html);
    const media = extractMediaMetadata({ openGraph, twitterCard, jsonLd, base: finalUrl });
    const text = htmlToReadableText(html);
    return {
        source: 'metadata',
        finalUrl,
        title,
        text,
        metadata: {
            canonicalUrl,
            description,
            feedUrls,
            oEmbedUrls,
            openGraph,
            twitterCard,
            media,
            jsonLd,
        },
        evidence: [
            title ? 'title' : null,
            description ? 'description' : null,
            canonicalUrl ? 'canonical' : null,
            feedUrls.length > 0 ? 'feed-link' : null,
            oEmbedUrls.length > 0 ? 'oembed-link' : null,
            Object.keys(media).length > 0 ? 'media-metadata' : null,
            jsonLd.length > 0 ? 'json-ld' : null,
        ].filter(Boolean),
        warnings: [] as string[],
    };
}

export function extractJsonLdBlocks(html: string = ''): unknown[] {
    const blocks: unknown[] = [];
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
        const raw = match[1]!.trim();
        if (!raw) continue;
        try {
            blocks.push(JSON.parse(raw));
        } catch {
            blocks.push({ raw, parseError: true });
        }
    }
    return blocks;
}

function extractOpenGraph(html: string): Record<string, string> {
    const og: Record<string, string> = {};
    for (const tag of metaTags(html)) {
        const property = getTagAttr(tag, 'property');
        if (!property.toLowerCase().startsWith('og:')) continue;
        const content = getTagAttr(tag, 'content');
        if (content) og[property.slice(3)] = content;
    }
    return og;
}

function extractTwitterCard(html: string): Record<string, string> {
    const twitter: Record<string, string> = {};
    for (const tag of metaTags(html)) {
        const name = getTagAttr(tag, 'name') || getTagAttr(tag, 'property');
        if (!name.toLowerCase().startsWith('twitter:')) continue;
        const content = getTagAttr(tag, 'content');
        if (content) twitter[name.slice('twitter:'.length)] = content;
    }
    return twitter;
}

function extractMediaMetadata(input: {
    openGraph: Record<string, string>;
    twitterCard: Record<string, string>;
    jsonLd: unknown[];
    base: string;
}): Record<string, unknown> {
    const jsonLdMedia = input.jsonLd.flatMap(findJsonLdMedia).slice(0, 5);
    const media: Record<string, unknown> = {};
    const imageUrl = resolveMaybeUrl(input.openGraph['image'] || input.twitterCard['image'] || '', input.base);
    const videoUrl = resolveMaybeUrl(input.openGraph['video'] || input.twitterCard['player'] || '', input.base);
    const audioUrl = resolveMaybeUrl(input.openGraph['audio'] || '', input.base);
    if (imageUrl) media['imageUrl'] = imageUrl;
    if (videoUrl) media['videoUrl'] = videoUrl;
    if (audioUrl) media['audioUrl'] = audioUrl;
    if (input.openGraph['image:width']) media['imageWidth'] = input.openGraph['image:width'];
    if (input.openGraph['image:height']) media['imageHeight'] = input.openGraph['image:height'];
    if (input.openGraph['video:width'] || input.twitterCard['player:width']) media['videoWidth'] = input.openGraph['video:width'] || input.twitterCard['player:width'];
    if (input.openGraph['video:height'] || input.twitterCard['player:height']) media['videoHeight'] = input.openGraph['video:height'] || input.twitterCard['player:height'];
    if (jsonLdMedia.length > 0) media['jsonLdMedia'] = jsonLdMedia;
    return media;
}

function findJsonLdMedia(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(findJsonLdMedia);
    if (!value || typeof value !== 'object') return [];
    const obj = value as Record<string, unknown>;
    const graph = Array.isArray(obj['@graph']) ? (obj['@graph'] as unknown[]).flatMap(findJsonLdMedia) : [];
    const type = String(obj['@type'] || '');
    const isMedia = /^(ImageObject|VideoObject|AudioObject|MediaObject)$/i.test(type);
    const nested = ['image', 'video', 'audio', 'thumbnail', 'thumbnailUrl']
        .flatMap(key => findJsonLdMedia(obj[key]));
    const current = isMedia ? [{
        type,
        name: normalizeWhitespace(String(obj['name'] || obj['headline'] || '')),
        url: normalizeWhitespace(String(obj['contentUrl'] || obj['embedUrl'] || obj['url'] || '')),
        thumbnailUrl: normalizeWhitespace(String(obj['thumbnailUrl'] || '')),
        duration: normalizeWhitespace(String(obj['duration'] || '')),
    }] : [];
    return [...current, ...graph, ...nested].filter(media => media['url'] || media['thumbnailUrl'] || media['name']);
}

function metaTags(html: string): string[] {
    return [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);
}

export function extractFeedUrls(html: string = '', base: string = ''): string[] {
    const urls: string[] = [];
    const re = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
        const tag = match[0];
        const rel = getTagAttr(tag, 'rel').toLowerCase();
        const type = getTagAttr(tag, 'type').toLowerCase();
        const href = getTagAttr(tag, 'href');
        if (!href || !/\balternate\b/.test(rel)) continue;
        if (!/(application\/rss\+xml|application\/atom\+xml|application\/feed\+json|text\/xml|application\/xml)/i.test(type)) continue;
        const resolved = resolveMaybeUrl(href, base);
        if (resolved && !urls.includes(resolved)) urls.push(resolved);
    }
    return urls;
}

export function extractOembedUrls(html: string = '', base: string = ''): string[] {
    const urls: string[] = [];
    const re = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
        const tag = match[0];
        const rel = getTagAttr(tag, 'rel').toLowerCase();
        const type = getTagAttr(tag, 'type').toLowerCase();
        const href = getTagAttr(tag, 'href');
        if (!href || !/\balternate\b/.test(rel)) continue;
        if (!/(application\/json\+oembed|text\/xml\+oembed|application\/xml\+oembed)/i.test(type)) continue;
        const resolved = resolveMaybeUrl(href, base);
        if (resolved && !urls.includes(resolved)) urls.push(resolved);
    }
    return urls;
}

function getMetaContent(html: string, attr: string, key: string): string {
    const re = new RegExp(`<meta\\s+[^>]*${escapeRegExp(attr)}=["']${escapeRegExp(key)}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i');
    const match = html.match(re);
    return match ? normalizeWhitespace(match[1]!) : '';
}

function getLinkHref(html: string, rel: string): string {
    const re = new RegExp(`<link\\s+[^>]*rel=["']${escapeRegExp(rel)}["'][^>]*href=["']([^"']*)["'][^>]*>`, 'i');
    const match = html.match(re);
    return match ? normalizeWhitespace(match[1]!) : '';
}

function getTagAttr(tag: string, attr: string): string {
    const re = new RegExp(`\\b${escapeRegExp(attr)}=["']([^"']*)["']`, 'i');
    const match = tag.match(re);
    return match ? normalizeWhitespace(match[1]!) : '';
}

function resolveMaybeUrl(raw: string, base: string): string {
    if (!raw) return '';
    try {
        return new URL(raw, base || undefined).href;
    } catch {
        return raw;
    }
}

function firstNonEmpty(...values: string[]): string {
    return values.find(v => typeof v === 'string' && v.trim()) || '';
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
