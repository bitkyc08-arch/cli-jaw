import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchSkillPath = join(__dirname, '../../skills_ref/search/SKILL.md');
const devSkillPath = join(__dirname, '../../skills_ref/dev/SKILL.md');
const devDebuggingSkillPath = join(__dirname, '../../skills_ref/dev-debugging/SKILL.md');
const devSecuritySkillPath = join(__dirname, '../../skills_ref/dev-security/SKILL.md');
const devDevopsSkillPath = join(__dirname, '../../skills_ref/dev-devops/SKILL.md');
const devBackendSkillPath = join(__dirname, '../../skills_ref/dev-backend/SKILL.md');
const devFrontendSkillPath = join(__dirname, '../../skills_ref/dev-frontend/SKILL.md');
const devTestingSkillPath = join(__dirname, '../../skills_ref/dev-testing/SKILL.md');
const registryPath = join(__dirname, '../../skills_ref/registry.json');
const hasSearchSkill = fs.existsSync(searchSkillPath);
const hasDevSkill = fs.existsSync(devSkillPath);
const hasDevDebuggingSkill = fs.existsSync(devDebuggingSkillPath);
const hasDevSecuritySkill = fs.existsSync(devSecuritySkillPath);
const hasDevDevopsSkill = fs.existsSync(devDevopsSkillPath);
const hasDevBackendSkill = fs.existsSync(devBackendSkillPath);
const hasDevFrontendSkill = fs.existsSync(devFrontendSkillPath);
const hasDevTestingSkill = fs.existsSync(devTestingSkillPath);

test('SSP-001: restored search skill is a registered unified search hub', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

    assert.match(searchSkill, /name: search/);
    assert.match(searchSkill, /Unified search hub/);
    assert.match(searchSkill, /4-tier escalation/);
    assert.ok(registry.skills.search, 'registry should include search skill');
    assert.equal(registry.skills.search.category, 'research');
});

test('SSP-002: search skill keeps four-tier escalation order', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Tier 1 — Built-in CLI Web Search/);
    assert.match(searchSkill, /Tier 2 — cli-jaw browser/);
    assert.match(searchSkill, /Tier 3 — progrok/);
    assert.match(searchSkill, /Tier 4 — web-ai/);
    assert.ok(
        searchSkill.indexOf('Tier 2 — cli-jaw browser') < searchSkill.indexOf('Tier 3 — progrok'),
        'browser verification should come before progrok'
    );
    assert.match(searchSkill, /Order is mandatory/);
});

test('SSP-003: Korean search policy treats snippets as discovery and requires original evidence', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Search is discovery, not evidence/);
    assert.match(searchSkill, /1-3 focused keyword queries/);
    assert.match(searchSkill, /URL candidates only/);
    assert.match(searchSkill, /Fetch\/open the original page/);
    assert.match(searchSkill, /browse-needed/);
    assert.match(searchSkill, /Naver shell\/iframe/);
    assert.match(searchSkill, /run Tier 2 browser verification before relying on secondary sources/);
    assert.match(searchSkill, /Secondary sources are corroboration, not substitutes/);
});

test('SSP-004: browser gate starts browser before skipping Tier 2', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /run `cli-jaw browser start --agent` and retry\s+status\/fetch once/);
    assert.match(searchSkill, /Skip Tier 2 only if browser start, status, or fetch still\s+fails/);
    assert.doesNotMatch(searchSkill, /browser not connected\), skip that tier/);
});

test('SSP-005: search skill does not hardcode a specific Jaw home', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.doesNotMatch(searchSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
    assert.match(searchSkill, /active `browser` skill from the current Jaw home/);
    assert.match(searchSkill, /active `web-ai` skill from the current Jaw home/);
});

test('SSP-006: agbrowse remains an optional planner, not a provider runner', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /agbrowse research plan --query "<request>" --json/);
    assert.match(searchSkill, /plan\.atomicQueries/);
    assert.match(searchSkill, /optional planning helper/);
    assert.match(searchSkill, /Do not use agbrowse to execute Exa,\s+Tavily, Perplexity, Brave, or any other search provider/);
});

test('SSP-007: /search is a routing command, not a provider implementation', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /`\/search <query>` is a routing command, not a provider implementation/);
    assert.match(searchSkill, /force the active agent to read and follow this search skill/);
    assert.match(searchSkill, /candidate URL discovery/);
    assert.match(searchSkill, /must not pass raw natural-language queries to browser fetch/);
    assert.match(searchSkill, /URL\/search-result URL reader, not generic\s+search/);
});

test('SSP-008: search skill documents browser command selection after candidate URLs', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /choose the smallest browser command that proves the\s+claim/);
    assert.match(searchSkill, /cli-jaw browser fetch <url> --json/);
    assert.match(searchSkill, /cli-jaw browser open <url>/);
    assert.match(searchSkill, /cli-jaw browser text/);
    assert.match(searchSkill, /cli-jaw browser get-dom --selector/);
    assert.match(searchSkill, /cli-jaw browser snapshot --interactive/);
    assert.match(searchSkill, /Adaptive fetch can read a known URL or a search-result URL/);
});

test('SSP-009: model-gated parallel research is bounded and evidence-gated', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Model-gated parallel research/);
    assert.match(searchSkill, /Use single-agent search by default/);
    assert.match(searchSkill, /cap it at 2-4 lanes/);
    assert.match(searchSkill, /official/);
    assert.match(searchSkill, /community/);
    assert.match(searchSkill, /realtime/);
    assert.match(searchSkill, /fetch/);
    assert.match(searchSkill, /Merge lane outputs into one evidence matrix/);
    assert.match(searchSkill, /Parallel snippets still do not\s+count as sufficient evidence/);
});

test('SSP-010: evidence status vocabulary is explicit', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Evidence status:/);
    assert.match(searchSkill, /`sufficient`: at least one original\/primary URL was opened or fetched/);
    assert.match(searchSkill, /`partial`: candidate evidence exists/);
    assert.match(searchSkill, /`browse-needed`: a candidate primary URL exists/);
    assert.match(searchSkill, /`insufficient`: no credible candidate evidence was obtained/);
});

test('SSP-011: search remains standalone owner for external evidence policy', { skip: !hasSearchSkill && 'skills_ref/search missing' }, () => {
    const searchSkill = fs.readFileSync(searchSkillPath, 'utf8');

    assert.match(searchSkill, /Standalone owner/);
    assert.match(searchSkill, /other skills may point here for external\/current evidence/);
    assert.match(searchSkill, /should not copy this tier policy/);
    assert.match(searchSkill, /Update this skill first/);
});

test('SSP-012: common dev skill points external current evidence to search', { skip: !hasDevSkill && 'skills_ref/dev missing' }, () => {
    const devSkill = fs.readFileSync(devSkillPath, 'utf8');

    assert.match(devSkill, /External\/current evidence/);
    assert.match(devSkill, /current versions, release notes, CVEs, package\/source checks, provider\s+behavior/);
    assert.match(devSkill, /read the active `search` skill/);
    assert.match(devSkill, /query-rewrite, source-fetch, and evidence-status rules/);
    assert.doesNotMatch(devSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-013: debugging skill routes current upstream bug evidence to search', { skip: !hasDevDebuggingSkill && 'skills_ref/dev-debugging missing' }, () => {
    const devDebuggingSkill = fs.readFileSync(devDebuggingSkillPath, 'utf8');

    assert.match(devDebuggingSkill, /third-party library\/API\/framework behavior/);
    assert.match(devDebuggingSkill, /current\s+error workarounds, upstream issues, changelogs, or migration guides/);
    assert.match(devDebuggingSkill, /read the\s+active `search` skill/);
    assert.match(devDebuggingSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devDebuggingSkill, /4-tier escalation/);
    assert.doesNotMatch(devDebuggingSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-014: security skill routes current supply-chain evidence to search', { skip: !hasDevSecuritySkill && 'skills_ref/dev-security missing' }, () => {
    const devSecuritySkill = fs.readFileSync(devSecuritySkillPath, 'utf8');

    assert.match(devSecuritySkill, /current CVEs, advisories, package maintainer\/source checks/);
    assert.match(devSecuritySkill, /release\s+integrity claims, or registry trust changes/);
    assert.match(devSecuritySkill, /read the active `search` skill/);
    assert.match(devSecuritySkill, /query-rewrite, original-source fetch, and evidence-status rules/);
    assert.doesNotMatch(devSecuritySkill, /4-tier escalation/);
    assert.doesNotMatch(devSecuritySkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-015: devops skill routes current release and provider evidence to search', { skip: !hasDevDevopsSkill && 'skills_ref/dev-devops missing' }, () => {
    const devDevopsSkill = fs.readFileSync(devDevopsSkillPath, 'utf8');

    assert.match(devDevopsSkill, /release, registry-auth, provider-doc, service-status/);
    assert.match(devDevopsSkill, /image\/platform\s+version, or package-manager behavior/);
    assert.match(devDevopsSkill, /read\s+the active `search` skill/);
    assert.match(devDevopsSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devDevopsSkill, /4-tier escalation/);
    assert.doesNotMatch(devDevopsSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-016: backend skill routes current API and provider evidence to search', { skip: !hasDevBackendSkill && 'skills_ref/dev-backend missing' }, () => {
    const devBackendSkill = fs.readFileSync(devBackendSkillPath, 'utf8');

    assert.match(devBackendSkill, /current external API docs, API lifecycle\s+changes/);
    assert.match(devBackendSkill, /LLM\/RAG provider behavior, dependency freshness/);
    assert.match(devBackendSkill, /package\/source\s+evidence/);
    assert.match(devBackendSkill, /read the active `search` skill/);
    assert.match(devBackendSkill, /query-rewrite,\s+source-fetch, and evidence-status rules/);
    assert.doesNotMatch(devBackendSkill, /4-tier escalation/);
    assert.doesNotMatch(devBackendSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-017: frontend skill routes current UI platform evidence to search', { skip: !hasDevFrontendSkill && 'skills_ref/dev-frontend missing' }, () => {
    const devFrontendSkill = fs.readFileSync(devFrontendSkillPath, 'utf8');

    assert.match(devFrontendSkill, /current framework, design-system, browser API/);
    assert.match(devFrontendSkill, /library behavior, browser-rendered source evidence/);
    assert.match(devFrontendSkill, /package\/source freshness/);
    assert.match(devFrontendSkill, /read the active `search` skill/);
    assert.match(devFrontendSkill, /source-fetch and evidence-status\s+rules/);
    assert.doesNotMatch(devFrontendSkill, /4-tier escalation/);
    assert.doesNotMatch(devFrontendSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});

test('SSP-018: testing skill routes current provider and environment evidence to search', { skip: !hasDevTestingSkill && 'skills_ref/dev-testing missing' }, () => {
    const devTestingSkill = fs.readFileSync(devTestingSkillPath, 'utf8');

    assert.match(devTestingSkill, /current external API behavior, provider docs/);
    assert.match(devTestingSkill, /CI service\s+behavior, test-environment versions/);
    assert.match(devTestingSkill, /dependency audit evidence, or recorded\s+mock\/fixture sources/);
    assert.match(devTestingSkill, /read the active `search` skill/);
    assert.match(devTestingSkill, /source-fetch and evidence-status rules/);
    assert.doesNotMatch(devTestingSkill, /4-tier escalation/);
    assert.doesNotMatch(devTestingSkill, /\/Users\/jun\/\.cli-jaw-\d+/);
});
