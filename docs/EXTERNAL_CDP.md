---
created: 2026-05-05
phase: 22
status: deferred
tags: [cli-jaw, external-cdp, deferred, experimental, agbrowse-mirror]
---

# External / Remote CDP Adapter — Deferred (Experimental)

## Status

**Deferred. Not for production use.**

`cli-jaw` does not own the external/remote CDP path. The local-CDP runtime
(via `agbrowse` and `cli-jaw`'s native browser cleanup surface) is the only
supported browser execution mode.

This document mirrors `agbrowse/docs/EXTERNAL_CDP.md` so that `cli-jaw`
release notes, README, and dashboard never accidentally claim hosted/cloud
or remote-CDP support before that contract exists.

## Authoritative source

See `agbrowse/docs/EXTERNAL_CDP.md` for the rationale, the requirements that
must be met to lift the deferral, and the rules for marking experimental
code (`// EXPERIMENTAL: not for production use`, opt-in flag,
truth-table sync, no README readiness claim).

## cli-jaw-specific rules

- `cli-jaw` MUST NOT introduce its own external/remote CDP adapter ahead of
  agbrowse. Any production claim must originate from agbrowse.
- The `gate:no-experimental-in-readme-ready-section` release gate enforces
  that "ready" sections of cli-jaw `README*.md` and the truth table do not
  mention external CDP, remote CDP, hosted browser, or unimplemented MCP
  tools as ready capabilities.
- `structure/CAPABILITY_TRUTH_TABLE.md` keeps External CDP in
  `deferred (experimental)`. Do not change this row without first updating
  `agbrowse/structure/CAPABILITY_TRUTH_TABLE.md` and
  `agbrowse/docs/EXTERNAL_CDP.md`.

## Lifting the deferral

Mirror the agbrowse process: only after agbrowse publishes a non-deferred
External CDP contract may cli-jaw consider exposing or claiming a mirrored
surface, and only with matching tests and truth-table updates.
