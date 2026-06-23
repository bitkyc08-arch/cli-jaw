export interface StructuredTable {
    caption?: string;
    headers: string[];
    rows: string[][];
}

export interface StructuredHeading {
    level: number;
    text: string;
}

export interface StructuredContent {
    headings: StructuredHeading[];
    tables: StructuredTable[];
    lists: Array<{ type: 'ordered' | 'unordered'; items: string[] }>;
    codeBlocks: Array<{ language: string; code: string }>;
    jsonLd: unknown[];
    mainText: string;
    wordCount: number;
}

const MAX_TABLE_ROWS = 50;

export function extractStructuredContent(html: string): StructuredContent {
    return {
        headings: extractHeadings(html),
        tables: extractTables(html),
        lists: extractLists(html),
        codeBlocks: extractCodeBlocks(html),
        jsonLd: extractJsonLd(html),
        mainText: '',
        wordCount: 0,
    };
}

function extractHeadings(html: string): StructuredHeading[] {
    const headings: StructuredHeading[] = [];
    const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        const text = stripTags(match[2] ?? '').trim();
        if (text) headings.push({ level: Number(match[1]), text });
    }
    return headings;
}

function extractTables(html: string): StructuredTable[] {
    const tables: StructuredTable[] = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        const tableHtml = tableMatch[1] ?? '';
        const caption = extractFirst(tableHtml, /<caption[^>]*>([\s\S]*?)<\/caption>/i);
        const headers: string[] = [];
        const headerRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
        let hm;
        while ((hm = headerRe.exec(tableHtml)) !== null) {
            headers.push(stripTags(hm[1] ?? '').trim());
        }
        const rows: string[][] = [];
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
            const cells: string[] = [];
            const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let cellMatch;
            while ((cellMatch = cellRe.exec(rowMatch[1] ?? '')) !== null) {
                cells.push(stripTags(cellMatch[1] ?? '').trim());
            }
            if (cells.length > 0 && rows.length < MAX_TABLE_ROWS) rows.push(cells);
        }
        if (headers.length > 0 || rows.length > 0) {
            const entry: StructuredTable = { headers, rows };
            if (caption) entry.caption = caption;
            tables.push(entry);
        }
    }
    return tables;
}

function extractLists(html: string): Array<{ type: 'ordered' | 'unordered'; items: string[] }> {
    const lists: Array<{ type: 'ordered' | 'unordered'; items: string[] }> = [];
    const listRe = /<(ol|ul)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = listRe.exec(html)) !== null) {
        const type = (match[1] ?? '').toLowerCase() === 'ol' ? 'ordered' as const : 'unordered' as const;
        const items: string[] = [];
        const itemRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let im;
        while ((im = itemRe.exec(match[2] ?? '')) !== null) {
            const text = stripTags(im[1] ?? '').trim();
            if (text) items.push(text);
        }
        if (items.length > 0) lists.push({ type, items });
    }
    return lists;
}

function extractCodeBlocks(html: string): Array<{ language: string; code: string }> {
    const blocks: Array<{ language: string; code: string }> = [];
    const re = /<pre[^>]*>[\s\S]*?<code[^>]*(?:class="[^"]*language-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        const code = decodeEntities(stripTags(match[2] ?? '')).trim();
        if (code) blocks.push({ language: match[1] || '', code });
    }
    return blocks;
}

function extractJsonLd(html: string): unknown[] {
    const results: unknown[] = [];
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        try {
            results.push(JSON.parse(match[1] ?? ''));
        } catch { /* malformed JSON-LD */ }
    }
    return results;
}

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}

function extractFirst(html: string, re: RegExp): string {
    const m = re.exec(html);
    return m ? stripTags(m[1] ?? '').trim() : '';
}
