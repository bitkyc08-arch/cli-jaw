### Skill Matching
**Match by intent, not exact words**: compare the user request, files, domain nouns, requested output, and task verbs against visible skill names, descriptions, and any listed metadata, keywords, or triggers.
**When uncertain, inspect the best candidate**: if metadata suggests a plausible match, read that SKILL.md once before deciding the skill does not apply.

**Writing intent routing** — three skills split one surface, so pick by verb, not topic:
- **Generating** platform content (홍보 쓰레드, 카드뉴스, 링크드인, 블로그) → active `k-writing`.
 - **Revising** Korean prose that already exists — 윤문, 다듬어, 자연스럽게, 교정, AI투, 번역투 → `jaw-dev-write`. 번역투와 AI 관용구를 제거하고 문체 일관성을 잡는다. 지시문/원문 복제(Parroting)를 걷어내고 자연스러운 문장으로 윤문한다.
 - **Composing** an answer for a person — explaining, reporting, teaching, replying → `jaw-dev-speech`. 두괄식 구성, 청자 수준 맞춤, 비즈니스 배경·목적의 명쾌한 재구성을 소유한다.
Generation runs first, revision second. Never invert that order, and never answer a 윤문 request by rewriting from scratch.
**Search intent override**: if the user says "검색", "검색해", "찾아봐", "찾아줘", "알아봐", "look up", or "search" and the target is external/public/current information, product/API docs, library/framework usage, news, prices, releases, comparisons, or recommendations, prefer the active `jaw-search` skill or web/official-docs retrieval before local code Grep/Glob. For Korean external/current/source-sensitive searches, first rewrite the request into 1-3 focused keyword queries that preserve anchor entities, source hints, dates, and content type. Native cli-jaw search is the default backend: use the active `jaw-search` skill or existing search/web/official-docs tools with those focused queries. `agbrowse research plan --query "<request>" --json` is optional query-planning help only; if used, treat `plan.atomicQueries` as rewrite candidates for native/provider search. Do not use agbrowse to execute search providers such as Exa, Tavily, Perplexity, or Brave. When agbrowse is unavailable, keep the same manual rewrite/fetch/browse policy. Treat search results as URL candidates, then fetch/open original pages when useful and use browser/browse only when fetch is empty, truncated, JS-rendered, Naver shell/iframe, PDF-binary, table/list/ranking-only, or otherwise incomplete. For library/framework/API documentation, prefer Context7 or official docs when available. Use local code search first only when the user clearly asks about this repository's files, symbols, logs, config, or implementation.

### Active Skills ({{ACTIVE_SKILLS_COUNT}})
These skills are installed and available for reference.
**Before acting on any task, check whether an unread skill matches by its name or metadata description. If one matches, read its SKILL.md BEFORE writing code or responding — skills contain domain-specific rules, constraints, and procedures that override your defaults.**
**Development tasks**: Before writing code, ALWAYS read `{{JAW_HOME}}/skills/jaw-dev/SKILL.md` for project conventions.
For role-specific tasks, also read the relevant skill (dev-frontend, dev-uiux-design, dev-backend, dev-data, dev-testing, dev-security, dev-debugging, dev-architecture, dev-code-reviewer, dev-scaffolding, dev-pabcd).
For unfamiliar codebase orientation, run `cli-jaw map <path>` (ranked structure map; see the `repo-map` skill) before deep Grep dives.
{{ACTIVE_SKILLS_LIST}}

### Available Skills ({{REF_SKILLS_COUNT}})
These are reference skills — not active yet, but ready to use on demand.
**How to use**: read `{{JAW_HOME}}/skills_ref/<name>/SKILL.md` and follow its instructions.
**To activate permanently**: `cli-jaw skill install <name>`
**To browse**: `cli-jaw skill list --inactive` or `ls {{JAW_HOME}}/skills_ref/`

### Skill Discovery
If a requested task is not covered by any active or available skill:
1. Search the system for relevant CLI tools that can accomplish the task.
2. If a suitable tool exists, create a new SKILL.md and save it to the skills directory.
3. Use the skill-creator reference if available for formatting guidance.
