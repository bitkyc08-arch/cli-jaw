# Quota reader migration from OpenCodex

This migration uses OpenCodex source revision
`b94051fe91e745806102988f6dff2fec8de078ef` as the provider protocol reference.
It preserves cli-jaw's CLI-keyed `/api/quota` response and native authentication
ownership. The contract below is implemented by the quota migration; verification and
completion are recorded with the individual pull requests.

| Reader | Required behavior |
| --- | --- |
| Claude | Canonical five-hour/weekly/model windows, including Fable and weekly-scoped limits; preserve fractional readings and distinguish unknown from exhausted. Cache only by credential identity; 429 can reuse only that identity's measured snapshot. |
| Codex | Classify declared short, weekly and monthly windows; preserve Go/Free policy, Spark weekly windows and read-only reset-credit counts. Honor `CODEX_HOME`; never infer zero from missing usage. |
| Grok | Prefer the JSON weekly credits response, retain gRPC weekly compatibility and validated monthly fallback. Isolate failed attempts and keep session usage separate. |
| Cursor | Read the native selected credential store and the three current usage endpoints. Direct auth token takes precedence; an overriding API key suppresses stored OAuth quota reads. Explicit dashboard cookie support remains separately sourced. |
| Kiro | Read the selected native token and region/profile metadata without mutation, use the management usage endpoint, select agentic/credit allowance, preserve trial and overage semantics. |
| OpenCode Go | Read rolling/weekly/monthly usage directly before any optional models authentication fallback; retain supported legacy shapes. |
| Antigravity | Read the active native account and project, request summary then available-model quotas, and preserve native IDE-local availability. Never mix local and selected remote accounts. |
| Copilot | Keep cli-jaw's native Premium quota reader: the reference has no equivalent subscription probe. |

## Compatibility and boundaries

Existing reader exports, `account`, `windows`, wrapper delegation and response keys
remain compatible. Window percentages are finite and clamped to 0–100 without
parser rounding. Unknown measurements do not become numeric zero. Reset dates
are ISO strings; seconds and milliseconds follow the reference threshold
`10_000_000_000`, except the WHAM seconds-only field. Existing native `raw`
response fields remain for compatibility and are not described as sanitized.

Provider bodies are limited to 512 KiB and bounded by a deadline. Credentials go
only to their fixed provider destinations. Google quota redirects are inspected
without following them, allowing explicit redirect-stop behavior to remain
distinct from a retryable network failure. No reader imports OAuth refresh,
account rotation, persisted proxy quotas, automatic reset-credit consumption or
inference machinery from the reference.

The shared wire boundary is a leaf dependency; native/provider adapters consume
it and the settings route consumes adapters. Each adapter includes synthetic
success, malformed input, absent input, authentication, timeout and fallback
fixtures. The route isolates provider failures and starts Grok concurrently with
its peers. A rejected provider must not suppress successful rows.

## Delivery and verification

Implement the shared wire foundation first, native account windows next, then
provider-specific slices, followed by aggregation and architecture documentation.
Publish ordinary dependent PRs with each layer's own behavioral tests and build.
Source attribution accompanies adapted code and the distributed MIT license.

Use the repository's programmatic test runner with explicit quota test paths.
The baseline before this migration passed 44 quota tests, TypeScript, the server
build and asset check, and all 540 architecture count entries. Build using
`npm run ensure:native`, `npm --ignore-scripts run build`, then
`bash scripts/verify-dist-assets.sh`; suppressing npm lifecycle scripts for this
build avoids the unrelated postbuild that reassigns global NVM package links.
These baseline results are not proof that later implementation changes pass.

Final delivery requires current branch-tip tests/builds, architecture count sync,
a synthetic HTTP smoke through the real registered route, and current per-PR CI.
Merging, releasing and restarting an installed service are separate operations.
