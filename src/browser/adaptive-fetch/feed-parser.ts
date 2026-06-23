import { normalizeWhitespace } from './transforms.js';

export interface ParsedFeedItem {
    title: string;
    date: string;
    url: string;
    summary: string;
    author: string;
    tags: string[];
    mediaUrl: string;
}

export interface ParsedFeed {
    kind: 'feed-json' | 'rss-atom';
    title: string;
    description: string;
    url: string;
    items: ParsedFeedItem[];
}

type Json = Record<string, unknown> | unknown[];

export function parsePublicFeed(rawText: string, json: Json | null): ParsedFeed | null {
    if (json) return parseJsonFeed(json);
    if (!/<(?:rss|feed|rdf:RDF|item|entry)\b/i.test(rawText)) return null;
    const itemBlocks = (xmlBlocks(rawText, 'item').length ? xmlBlocks(rawText, 'item') : xmlBlocks(rawText, 'entry')).slice(0, 5);
    const title = xmlTag(rawText, 'title') || 'RSS/Atom feed';
    return {
        kind: 'rss-atom',
        title,
        description: xmlTag(rawText, 'description') || xmlTag(rawText, 'subtitle'),
        url: xmlTag(rawText, 'link') || xmlLinkHref(rawText),
        items: itemBlocks.slice(0, 3).map(parseXmlFeedItem),
    };
}

export function formatFeedEvidence(feed: ParsedFeed) {
    const lines = [
        `Feed: ${feed.title}`,
        line('Description', feed.description),
        line('Home', feed.url),
        ...feed.items.flatMap((item, index) => feedItemLines(item, index)),
    ].filter((value): value is string => Boolean(value && normalizeWhitespace(value)));
    return {
        kind: feed.kind,
        title: normalizeWhitespace(feed.title),
        text: normalizeWhitespace(lines.join('\n')),
        metadata: {
            feedKind: feed.kind,
            items: feed.items.length,
            itemUrls: feed.items.map(item => item.url).filter(Boolean),
            mediaUrls: feed.items.map(item => item.mediaUrl).filter(Boolean),
        },
    };
}

function parseJsonFeed(json: Json): ParsedFeed | null {
    const obj = asObject(json);
    const items = arr(obj['items']).slice(0, 3).map(value => {
        const item = asObject(value);
        const author = asObject(item['author']);
        const authors = arr(item['authors'])
            .map(value => str(asObject(value)['name'] || asObject(value)['url']))
            .filter(Boolean);
        return {
            title: str(item['title']),
            date: str(item['date_published'] || item['date_modified']),
            url: str(item['url'] || item['external_url']),
            summary: clip(stripHtml(str(item['summary'] || item['content_text'] || item['content_html']))),
            author: str(author['name'] || author['url']) || authors.join(', '),
            tags: arr(item['tags']).map(str).filter(Boolean),
            mediaUrl: firstAttachmentUrl(item),
        };
    });
    const title = str(obj['title']);
    if (!title && items.length === 0) return null;
    return {
        kind: 'feed-json',
        title: title || 'Feed',
        description: str(obj['description']),
        url: str(obj['home_page_url'] || obj['feed_url']),
        items,
    };
}

function parseXmlFeedItem(block: string): ParsedFeedItem {
    return {
        title: xmlTag(block, 'title'),
        date: xmlTag(block, 'pubDate') || xmlTag(block, 'published') || xmlTag(block, 'updated'),
        url: xmlTag(block, 'link') || xmlLinkHref(block) || xmlTag(block, 'guid') || xmlTag(block, 'id'),
        summary: clip(stripHtml(xmlTag(block, 'description') || xmlTag(block, 'summary') || xmlTag(block, 'encoded') || xmlTag(block, 'content'))),
        author: xmlTag(block, 'creator') || xmlTag(block, 'author') || xmlTag(block, 'name'),
        tags: [...new Set(xmlTags(block, 'category').map(str).filter(Boolean))],
        mediaUrl: enclosureUrl(block) || mediaUrl(block),
    };
}

function feedItemLines(item: ParsedFeedItem, index: number): string[] {
    return [
        item.title ? `Item ${index + 1}: ${item.title}` : '',
        line('  Date', item.date),
        line('  URL', item.url),
        line('  Author', item.author),
        line('  Tags', item.tags.join(', ')),
        line('  Media', item.mediaUrl),
        line('  Summary', item.summary),
    ].filter((value): value is string => Boolean(value));
}

function firstAttachmentUrl(item: Record<string, unknown>): string {
    const attachment = asObject(arr(item['attachments'])[0]);
    return str(attachment['url']);
}

function xmlBlocks(xml: string, tag: string): string[] {
    const tagPattern = `(?:[\\w.-]+:)?${escapeRegExp(tag)}`;
    return [...xml.matchAll(new RegExp(`<${tagPattern}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagPattern}>`, 'gi'))].map(match => match[0]);
}

function xmlTags(xml: string, tag: string): string[] {
    const tagPattern = `(?:[\\w.-]+:)?${escapeRegExp(tag)}`;
    return [...xml.matchAll(new RegExp(`<${tagPattern}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagPattern}>`, 'gi'))].map(match => cleanXml(match[1] || ''));
}

function xmlTag(xml: string, tag: string): string {
    return xmlTags(xml, tag)[0] || '';
}

function xmlLinkHref(xml: string): string {
    const match = xml.match(/<(?:[\w.-]+:)?link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    return cleanXml(match?.[1] || '');
}

function enclosureUrl(xml: string): string {
    const match = xml.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*\/?>/i);
    return cleanXml(match?.[1] || '');
}

function mediaUrl(xml: string): string {
    const match = xml.match(/<(?:media|mrss):(?:thumbnail|content)\b[^>]*(?:url|href)=["']([^"']+)["'][^>]*\/?>/i);
    return cleanXml(match?.[1] || '');
}

function line(label: string, value: unknown): string | null {
    const text = Array.isArray(value) ? value.map(str).filter(Boolean).join(', ') : str(value);
    return text ? `${label}: ${text}` : null;
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arr(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
    if (value == null) return '';
    return normalizeWhitespace(String(value));
}

function stripHtml(value: string): string {
    return normalizeWhitespace(decodeXml(value).replace(/<[^>]+>/g, ' '));
}

function cleanXml(value: string): string {
    return stripHtml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function decodeXml(value: string): string {
    return value
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(parseInt(num, 10)));
}

function clip(value: string, max = 240): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
