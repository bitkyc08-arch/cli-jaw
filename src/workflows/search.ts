export interface SearchWorkflowPromptOptions {
    query: string;
    jawHome?: string;
}

export function buildSearchSteerPrompt(options: SearchWorkflowPromptOptions): string {
    const query = options.query.trim();
    const home = options.jawHome || process.env['CLI_JAW_HOME'] || '~/.cli-jaw';
    return [
        '[System] User invoked /search.',
        '',
        `User search request: ${JSON.stringify(query)}`,
        '',
        'MUST READ before searching:',
        `- Search routing + evidence policy: ${home}/skills/search/SKILL.md`,
        `- Adaptive-fetch ladder (23 resolvers, TLS, Jina, Camoufox): ${home}/skills/browser/SKILL.md §Known URL Reader`,
        '',
        'Follow the search skill workflow. On fetch failure, use `cli-jaw browser fetch <url>` — the adaptive-fetch ladder handles escalation automatically.',
        '',
        'Report format (defined in search skill §/search report format):',
        'focused_queries | search_route_used | candidate_urls | original_pages_opened_or_fetched',
        'browse_escalation_decision | parallel_research_decision | final_answer',
        'evidence_status | remaining_uncertainty',
    ].join('\n');
}
