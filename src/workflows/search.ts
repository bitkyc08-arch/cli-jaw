export interface SearchWorkflowPromptOptions {
    query: string;
}

export function buildSearchSteerPrompt(options: SearchWorkflowPromptOptions): string {
    const query = options.query.trim();
    return [
        '[System] User invoked /search. Route this request through the active search skill.',
        '',
        `User search request: ${JSON.stringify(query)}`,
        '',
        'Required workflow:',
        '1. Read and follow the active search skill before searching.',
        '2. Classify the request: local repository search vs external/current/public web lookup.',
        '3. If it is local repository search, use file/code search tools and say browser/web search is not needed.',
        '4. If it is external/current/public lookup, rewrite the request into 1-3 focused keyword queries.',
        '5. Use native search first to discover candidate URLs. Treat snippets as candidate discovery only.',
        '6. Use browser commands only after candidate URLs exist. Prefer `cli-jaw browser fetch <url> --json`; use `open`, `text`, `get-dom`, or `snapshot` when rendered DOM, tables, JS shells, Naver pages, PDFs, or interaction are needed.',
        '7. Do not pass raw natural-language queries to `cli-jaw browser fetch`.',
        '8. Fetch or open at least one original/primary source before marking evidence sufficient.',
        '9. Apply model-gated parallel research only when the request needs breadth, disconfirmation, realtime/community comparison, or blocked-source verification. Do not call /team or dispatch employees automatically in /search v1.',
        '10. If parallel research is useful, split into 2-4 source lanes: official, community, realtime, and fetch/browser verification. Merge results yourself into an evidence matrix.',
        '',
        'Final report fields:',
        'focused_queries: <1-3 rewritten queries or local-search rationale>',
        'search_route_used: <tier/tool path actually used>',
        'candidate_urls: <URL candidates considered>',
        'original_pages_opened_or_fetched: <primary/original URLs actually opened or fetched>',
        'browse_escalation_decision: <why browser fetch/open/text/get-dom/snapshot was or was not needed>',
        'parallel_research_decision: <single-agent or model-gated parallel lanes, with reason>',
        'final_answer: <answer>',
        'evidence_status: <sufficient | partial | browse-needed | insufficient, per claim>',
        'remaining_uncertainty: <what could not be verified>',
    ].join('\n');
}
