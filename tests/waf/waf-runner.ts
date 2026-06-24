import { getWafManifest, type WafTestEntry } from './waf-manifest.js';

export interface WafResult {
    id: string;
    wafFamily: string;
    url: string;
    ok: boolean;
    source: string;
    verdict: string;
    latencyMs: number;
    evidence: string[];
}

export async function runWafSuite(options?: {
    filter?: string;
    browserMode?: string;
    timeout?: number;
}): Promise<WafResult[]> {
    const { runAdaptiveFetch } = await import('../../src/browser/adaptive-fetch/index.js');
    const entries = getWafManifest(options?.filter);
    const results: WafResult[] = [];

    for (const entry of entries) {
        const start = performance.now();
        try {
            const result = await runAdaptiveFetch({
                url: entry.url,
                json: true,
                trace: true,
                browser: options?.browserMode || 'auto',
                timeoutMs: options?.timeout || 30000,
            });
            results.push({
                id: entry.id,
                wafFamily: entry.wafFamily,
                url: entry.url,
                ok: Boolean(result['ok']),
                source: String(result['source'] || 'none'),
                verdict: String(result['verdict'] || 'unknown'),
                latencyMs: Math.round(performance.now() - start),
                evidence: (result['evidence'] as string[]) || [],
            });
        } catch (err) {
            results.push({
                id: entry.id,
                wafFamily: entry.wafFamily,
                url: entry.url,
                ok: false,
                source: 'error',
                verdict: 'error',
                latencyMs: Math.round(performance.now() - start),
                evidence: [(err as Error).message],
            });
        }
    }
    return results;
}

export function formatWafReport(results: WafResult[]): string {
    const families = [...new Set(results.map(r => r.wafFamily))];
    const lines = ['WAF Family       | Total | Pass | Fail | Rate', '-'.repeat(50)];
    for (const family of families) {
        const group = results.filter(r => r.wafFamily === family);
        const pass = group.filter(r => r.ok).length;
        const fail = group.length - pass;
        const rate = group.length > 0 ? ((pass / group.length) * 100).toFixed(1) : '0.0';
        lines.push(`${family.padEnd(17)}| ${String(group.length).padStart(5)} | ${String(pass).padStart(4)} | ${String(fail).padStart(4)} | ${rate}%`);
    }
    lines.push('');
    for (const r of results) {
        const status = r.ok ? '✅' : '❌';
        lines.push(`${status} ${r.id}: ${r.verdict} via ${r.source} (${r.latencyMs}ms)`);
    }
    return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    if (!process.env['WAF_TEST_ENABLED']) {
        console.log('WAF tests are live-network tests. Set WAF_TEST_ENABLED=1 to run.');
        process.exit(0);
    }
    const filter = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];
    runWafSuite({ filter }).then(results => {
        console.log(formatWafReport(results));
        if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
    }).catch(console.error);
}
