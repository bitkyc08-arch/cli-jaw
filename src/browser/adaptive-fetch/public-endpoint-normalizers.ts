// Normalizes known public endpoint API responses into readable evidence text.

import { normalizeWhitespace } from './transforms.js';

interface NormalizerContext {
    source?: string;
    label?: string;
}

interface NormalizedEndpointPayload extends Record<string, unknown> {
    source: string;
    label: string;
    finalUrl: string;
    title: string;
    text: string;
    contentType: string;
    status: number;
    ok: boolean;
    metadata: Record<string, unknown>;
    evidence: string[];
    warnings: string[];
    rawTextLength: number;
}

type Json = Record<string, unknown> | unknown[];

export function normalizePublicEndpointResult(
    fetched: Record<string, unknown>,
    context: NormalizerContext = {},
): NormalizedEndpointPayload | null {
    const label = String(context.label || '');
    const source = String(context.source || '');
    if (source !== 'public_endpoint' && !isKnownPublicEndpointLabel(label)) return null;
    const rawText = String(fetched['text'] || '');
    if (!rawText.trim()) return null;
    const contentType = String(fetched['contentType'] || '');
    const finalUrl = String(fetched['finalUrl'] || '');
    const status = Number(fetched['status'] || 0);
    const ok = fetched['ok'] !== false;
    const json = parseJson(rawText);
    const built = buildByLabel(label, rawText, json);
    if (!built) return null;
    return {
        source: 'public_endpoint',
        label,
        finalUrl,
        title: built.title,
        text: built.text,
        contentType,
        status,
        ok,
        metadata: {
            endpointLabel: label,
            endpointKind: built.kind,
            ...built.metadata,
        },
        evidence: [
            `public-endpoint:${label}`,
            built.kind,
            ...(Array.isArray(fetched['evidence']) ? fetched['evidence'] as string[] : []),
        ],
        warnings: Array.isArray(fetched['warnings']) ? fetched['warnings'] as string[] : [],
        rawTextLength: rawText.length,
    };
}

function buildByLabel(label: string, rawText: string, json: Json | null) {
    if (label === 'github-repo-api') return githubRepo(json);
    if (label.startsWith('npm-registry')) return npmRegistry(json);
    if (label === 'pypi-json') return pypi(json);
    if (label === 'hacker-news-item-api') return hackerNewsItem(json);
    if (label === 'hacker-news-algolia-item-api') return hackerNewsAlgolia(json);
    if (label === 'wikipedia-summary-api') return wikipediaSummary(json);
    if (label === 'arxiv-api') return arxiv(rawText);
    if (label === 'crossref-work-api') return crossref(json);
    if (label.startsWith('openlibrary-')) return openLibrary(json);
    if (label === 'wayback-cdx-api') return wayback(json);
    if (label === 'stackexchange-question-api') return stackExchange(json);
    if (label === 'devto-article-api') return devto(json);
    if (label.startsWith('bluesky-')) return bluesky(json);
    if (label.startsWith('mastodon-')) return mastodon(json);
    if (label === 'youtube-oembed' || label === 'x-twitter-oembed' || label === 'oembed-discovered') return oembed(json);
    if (label === 'v2ex-topic-api') return v2ex(json);
    if (label === 'lobsters-story-json') return lobsters(json);
    if (label === 'reddit-json') return reddit(json);
    if (label === 'rss-atom-discovered') return rssAtom(rawText, json);
    return null;
}

function githubRepo(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['full_name']);
    if (!title) return null;
    return built('github-repo', title, [
        `Repository: ${title}`,
        line('Description', obj['description']),
        line('Default branch', obj['default_branch']),
        line('Stars', obj['stargazers_count']),
        line('Forks', obj['forks_count']),
        line('Open issues', obj['open_issues_count']),
        line('License', asObject(obj['license'])['spdx_id']),
        line('URL', obj['html_url']),
    ], { fullName: title });
}

function npmRegistry(json: Json | null) {
    const obj = asObject(json);
    const latest = str(asObject(obj['dist-tags'])['latest']);
    const version = str(obj['version']) || latest;
    const title = [str(obj['name']), version].filter(Boolean).join('@');
    if (!title) return null;
    return built('npm-registry', title, [
        `Package: ${title}`,
        line('Description', obj['description']),
        line('License', obj['license']),
        line('Latest', latest),
        line('Homepage', obj['homepage']),
        line('Repository', repositoryUrl(obj['repository'])),
    ], { name: obj['name'], version });
}

function pypi(json: Json | null) {
    const info = asObject(asObject(json)['info']);
    const title = [str(info['name']), str(info['version'])].filter(Boolean).join(' ');
    if (!title.trim()) return null;
    return built('pypi-json', title, [
        `Package: ${title}`,
        line('Summary', info['summary']),
        line('License', info['license']),
        line('Project URL', info['package_url'] || info['home_page']),
        line('Requires Python', info['requires_python']),
    ], { name: info['name'], version: info['version'] });
}

function hackerNewsItem(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']) || `HN item ${str(obj['id'])}`;
    return built('hacker-news', title, [
        `Hacker News: ${title}`,
        line('By', obj['by']),
        line('Score', obj['score']),
        line('Comments', obj['descendants']),
        line('URL', obj['url']),
        line('Text', stripHtml(str(obj['text']))),
    ], { id: obj['id'] });
}

function hackerNewsAlgolia(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']) || `HN item ${str(obj['id'])}`;
    return built('hacker-news-algolia', title, [
        `Hacker News: ${title}`,
        line('Author', obj['author']),
        line('Points', obj['points']),
        line('Children', Array.isArray(obj['children']) ? obj['children'].length : ''),
        line('URL', obj['url']),
        line('Text', stripHtml(str(obj['text']))),
    ], { id: obj['id'] });
}

function wikipediaSummary(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']);
    if (!title) return null;
    return built('wikipedia-summary', title, [
        `Wikipedia: ${title}`,
        line('Description', obj['description']),
        line('Extract', obj['extract']),
        line('URL', str(asObject(asObject(obj['content_urls'])['desktop'])['page'])),
    ], { pageId: obj['pageid'] });
}

function arxiv(xml: string) {
    const title = xmlTag(xml, 'title', 1);
    const summary = xmlTag(xml, 'summary');
    if (!title && !summary) return null;
    const authors = [...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
        .map(match => cleanXml(match[1] || ''))
        .filter(Boolean)
        .slice(0, 5);
    return built('arxiv-api', title || 'arXiv record', [
        `arXiv: ${title}`,
        line('Authors', authors.join(', ')),
        line('Published', xmlTag(xml, 'published')),
        line('Updated', xmlTag(xml, 'updated')),
        line('Summary', summary),
        line('URL', xmlTag(xml, 'id')),
    ], { authors });
}

function crossref(json: Json | null) {
    const msg = asObject(asObject(json)['message']);
    const title = firstArrayString(msg['title']) || str(msg['DOI']);
    if (!title) return null;
    return built('crossref-work', title, [
        `CrossRef: ${title}`,
        line('DOI', msg['DOI']),
        line('Publisher', msg['publisher']),
        line('Journal', firstArrayString(msg['container-title'])),
        line('Published', dateParts(msg['published-print']) || dateParts(msg['published-online'])),
        line('URL', msg['URL']),
    ], { doi: msg['DOI'] });
}

function openLibrary(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']);
    if (!title) return null;
    const description = typeof obj['description'] === 'string' ? obj['description'] : str(asObject(obj['description'])['value']);
    return built('openlibrary', title, [
        `OpenLibrary: ${title}`,
        line('Description', description),
        line('Subjects', arr(obj['subjects']).slice(0, 8).join(', ')),
        line('First publish date', obj['first_publish_date']),
    ], { key: obj['key'] });
}

function wayback(json: Json | null) {
    const rows = Array.isArray(json) ? json as unknown[] : [];
    const captures = rows.slice(1, 6).map(row => Array.isArray(row) ? row : []);
    if (captures.length === 0) return null;
    return built('wayback-cdx', 'Wayback captures', [
        'Wayback captures:',
        ...captures.map(row => `- ${str(row[0])} ${str(row[2])} ${str(row[3])} ${str(row[1])}`),
    ], { captures: captures.length });
}

function stackExchange(json: Json | null) {
    const item = asObject(arr(asObject(json)['items'])[0]);
    const title = str(item['title']);
    if (!title) return null;
    return built('stackexchange-question', title, [
        `Stack Exchange: ${title}`,
        line('Score', item['score']),
        line('Answers', item['answer_count']),
        line('Accepted', item['is_answered']),
        line('URL', item['link']),
        line('Body', stripHtml(str(item['body']))),
    ], { questionId: item['question_id'] });
}

function devto(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']);
    if (!title) return null;
    return built('devto-article', title, [
        `dev.to: ${title}`,
        line('By', str(asObject(obj['user'])['username'])),
        line('Published', obj['readable_publish_date'] || obj['published_at']),
        line('Tags', arr(obj['tags']).join(', ')),
        line('Description', obj['description']),
        line('URL', obj['url']),
    ], { id: obj['id'] });
}

function bluesky(json: Json | null) {
    const root = asObject(json);
    const post = asObject(root['post'] || asObject(root['thread'])['post']);
    const record = asObject(post['record']);
    const author = asObject(post['author']);
    const text = str(record['text']) || str(root['description']);
    const title = [str(author['displayName']) || str(author['handle']), text.slice(0, 80)].filter(Boolean).join(': ');
    if (!title) return null;
    return built('bluesky-public-api', title, [
        `Bluesky: ${title}`,
        line('Author', str(author['handle'])),
        line('Text', text),
        line('Replies', post['replyCount']),
        line('Reposts', post['repostCount']),
        line('Likes', post['likeCount']),
    ], { uri: post['uri'] });
}

function mastodon(json: Json | null) {
    const obj = asObject(json);
    const account = asObject(obj['account']);
    const title = str(account['display_name']) || str(account['acct']) || 'Mastodon status';
    const content = stripHtml(str(obj['content']) || str(obj['note']));
    return built('mastodon-public-api', title, [
        `Mastodon: ${title}`,
        line('Account', account['acct']),
        line('Created', obj['created_at']),
        line('Text', content),
        line('Reblogs', obj['reblogs_count']),
        line('Favourites', obj['favourites_count']),
    ], { id: obj['id'] });
}

function oembed(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']) || str(obj['author_name']) || str(obj['provider_name']);
    if (!title) return null;
    return built('oembed', title, [
        `oEmbed: ${title}`,
        line('Provider', obj['provider_name']),
        line('Author', obj['author_name']),
        line('Type', obj['type']),
        line('URL', obj['url']),
        line('HTML text', stripHtml(str(obj['html']))),
    ], { provider: obj['provider_name'] });
}

function v2ex(json: Json | null) {
    const obj = asObject(Array.isArray(json) ? json[0] : json);
    const member = asObject(obj['member']);
    const title = str(obj['title']);
    if (!title) return null;
    return built('v2ex-topic', title, [
        `V2EX: ${title}`,
        line('By', member['username']),
        line('Replies', obj['replies']),
        line('URL', obj['url']),
        line('Content', obj['content_rendered'] || obj['content']),
    ], { id: obj['id'] });
}

function lobsters(json: Json | null) {
    const obj = asObject(json);
    const title = str(obj['title']);
    if (!title) return null;
    return built('lobsters-story', title, [
        `Lobsters: ${title}`,
        line('By', obj['submitter_user']),
        line('Score', obj['score']),
        line('Comments', obj['comments_count']),
        line('URL', obj['url']),
        line('Description', stripHtml(str(obj['description']))),
    ], { shortId: obj['short_id'] });
}

function reddit(json: Json | null) {
    const root = Array.isArray(json) ? asObject(json[0]) : asObject(json);
    const data = asObject(root['data']);
    const child = asObject(arr(data['children'])[0]);
    const post = asObject(child['data'] || data);
    const title = str(post['title']);
    if (!title) return null;
    return built('reddit-json', title, [
        `Reddit: ${title}`,
        line('Subreddit', post['subreddit_name_prefixed'] || post['subreddit']),
        line('By', post['author']),
        line('Score', post['score']),
        line('Comments', post['num_comments']),
        line('URL', post['url']),
        line('Text', post['selftext']),
    ], { id: post['id'] });
}

function rssAtom(rawText: string, json: Json | null) {
    if (json) {
        const obj = asObject(json);
        const title = str(obj['title']) || 'Feed';
        const items = arr(obj['items']).slice(0, 3).map(feedJsonItem);
        return built('feed-json', title, [
            `Feed: ${title}`,
            line('Home', obj['home_page_url']),
            ...feedItemLines(items),
        ], { items: items.length });
    }
    const title = xmlTag(rawText, 'title') || 'RSS/Atom feed';
    const itemBlocks = (xmlBlocks(rawText, 'item').length ? xmlBlocks(rawText, 'item') : xmlBlocks(rawText, 'entry')).slice(0, 3);
    const items = itemBlocks.map(block => ({
        title: xmlTag(block, 'title'),
        date: xmlTag(block, 'pubDate') || xmlTag(block, 'published') || xmlTag(block, 'updated'),
        url: xmlTag(block, 'link') || xmlLinkHref(block),
        summary: clip(stripHtml(xmlTag(block, 'description') || xmlTag(block, 'summary') || xmlTag(block, 'content'))),
    }));
    return built('rss-atom', title, [
        `Feed: ${title}`,
        line('Description', xmlTag(rawText, 'description') || xmlTag(rawText, 'subtitle')),
        line('URL', xmlTag(rawText, 'link') || xmlLinkHref(rawText)),
        ...feedItemLines(items),
    ], { items: items.length });
}

function feedJsonItem(value: unknown): Record<string, string> {
    const obj = asObject(value);
    return {
        title: str(obj['title']),
        date: str(obj['date_published'] || obj['date_modified']),
        url: str(obj['url'] || obj['external_url']),
        summary: clip(stripHtml(str(obj['summary'] || obj['content_text'] || obj['content_html']))),
    };
}

function feedItemLines(items: Record<string, string>[]): string[] {
    return items.flatMap((item, index) => [
        item['title'] ? `Item ${index + 1}: ${item['title']}` : '',
        line('  Date', item['date']),
        line('  URL', item['url']),
        line('  Summary', item['summary']),
    ].filter((line): line is string => Boolean(line)));
}

function xmlBlocks(xml: string, tag: string): string[] {
    return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi'))].map(match => match[0]);
}

function xmlLinkHref(xml: string): string {
    const match = xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    return cleanXml(match?.[1] || '');
}

function built(kind: string, title: string, lines: (string | null | undefined)[], metadata: Record<string, unknown>) {
    const text = lines.filter((line): line is string => Boolean(line && normalizeWhitespace(line))).join('\n');
    if (!text.trim()) return null;
    return { kind, title: normalizeWhitespace(title), text: normalizeWhitespace(text), metadata };
}

function parseJson(raw: string): Json | null {
    try {
        return JSON.parse(raw) as Json;
    } catch {
        return null;
    }
}

function isKnownPublicEndpointLabel(label: string): boolean {
    return /^(github-|reddit-|hacker-news-|wikipedia-|npm-|pypi-|arxiv-|bluesky-|mastodon-|stackexchange-|devto-|crossref-|openlibrary-|wayback-|youtube-|x-twitter-|v2ex-|lobsters-|rss-|oembed-)/.test(label);
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

function line(label: string, value: unknown): string | null {
    const text = Array.isArray(value) ? value.map(str).filter(Boolean).join(', ') : str(value);
    return text ? `${label}: ${text}` : null;
}

function firstArrayString(value: unknown): string {
    return str(arr(value)[0]);
}

function repositoryUrl(value: unknown): string {
    if (typeof value === 'string') return value;
    return str(asObject(value)['url']).replace(/^git\+/, '');
}

function dateParts(value: unknown): string {
    const parts = arr(asObject(value)['date-parts'])[0];
    return Array.isArray(parts) ? parts.map(str).filter(Boolean).join('-') : '';
}

function stripHtml(value: string): string {
    return normalizeWhitespace(value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

function clip(value: string, max = 240): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function xmlTag(xml: string, tag: string, index = 0): string {
    const matches = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'))];
    return cleanXml(matches[index]?.[1] || '');
}

function cleanXml(value: string): string {
    return stripHtml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}
