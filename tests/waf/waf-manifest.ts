export interface WafTestEntry {
    id: string;
    url: string;
    wafFamily: 'cloudflare' | 'akamai' | 'perimeterx' | 'datadome' | 'unknown';
    expectedBehavior: 'should_pass' | 'may_block' | 'likely_block';
    notes: string;
}

export const WAF_MANIFEST: WafTestEntry[] = [
    { id: 'cf-reddit', url: 'https://www.reddit.com/r/programming/', wafFamily: 'cloudflare', expectedBehavior: 'should_pass', notes: 'Cloudflare, .json bypass available' },
    { id: 'cf-medium', url: 'https://medium.com/@test/sample', wafFamily: 'cloudflare', expectedBehavior: 'should_pass', notes: 'Cloudflare, oembed available' },
    { id: 'cf-linkedin', url: 'https://www.linkedin.com/posts/test/', wafFamily: 'cloudflare', expectedBehavior: 'may_block', notes: 'Cloudflare + bot detection' },
    { id: 'ak-naver-finance', url: 'https://finance.naver.com/item/main.naver?code=005930', wafFamily: 'akamai', expectedBehavior: 'should_pass', notes: 'Akamai, public JSON API' },
    { id: 'ak-naver-blog', url: 'https://blog.naver.com/test/1234', wafFamily: 'akamai', expectedBehavior: 'should_pass', notes: 'Akamai, mobile page fallback' },
    { id: 'px-coupang', url: 'https://www.coupang.com/', wafFamily: 'perimeterx', expectedBehavior: 'likely_block', notes: 'PerimeterX heavy bot detection' },
    { id: 'dd-ticketmaster', url: 'https://www.ticketmaster.com/', wafFamily: 'datadome', expectedBehavior: 'likely_block', notes: 'DataDome aggressive blocking' },
];

export function getWafManifest(filter?: string): WafTestEntry[] {
    if (!filter) return [...WAF_MANIFEST];
    return WAF_MANIFEST.filter(e => e.wafFamily === filter || e.id.startsWith(filter));
}
