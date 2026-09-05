---
created: 2026-06-15
tags: [cli-jaw, tui, scrollback, ghostty, architecture]
---

# TUI Native Scrollback Architecture

> Terminal-level transcript history commit for Ghostty 1.3+ inline fullscreen mode.

## Overview

cli-jaw fullscreen TUI renders on the **primary screen buffer** (no alt-screen). Native terminal scrollback allows users to scroll up with trackpad/wheel to see earlier conversation history.

## How It Works

```
User sends message → AI responds → stable transcript prefix forms
→ peekStableCommitRows() returns rows to commit
→ queueCommitLines() queues them
→ render() flushes via sub-region DECSTBM scroll inside synchronized output
→ committed rows enter Ghostty scrollback
→ markCommittedFrontier() advances viewport pointer
→ next frame excludes committed rows (no duplication)
```

**Mid-stream stable-prefix commits are enabled.** The scheduler computes
`computeStablePrefixIndex()` and commits only the already-stable prefix while the
tail may still stream. The top-anchored history lane writes only into
model-blank fill rows, so per-token diff repaint and commit flush target
disjoint rows. Preview hiding is queue-gated: if `queueCommitLines()` refuses the
lane, rows stay visible on the virtual lane instead of disappearing.

## Terminal Protocol

The commit uses a **sub-region per-line scroll** — the fill area (blank padding at screen top) is used as a history lane:

```
CSI 1;${fillRows}r       Set scroll region to fill area (rows 1..fillRows)
CSI ${fillRows};1H        Cursor to bottom of region
\r\n                      Scroll: top row exits to Ghostty scrollback
\x1b[2K + text            Clear freed bottom row + write committed content
(repeat for each line)
CSI r                     Reset scroll region
CSI cursor;1H             Restore cursor position
```

**Key Ghostty behavior** (PR #9907, merged 2025-12-14): When scroll region top = row 1 and full terminal width, scrolling creates scrollback even with bottom < screen height.

## MIN_HISTORY_LANE

The transcript area is reduced by `MIN_HISTORY_LANE = 5` rows when transcript items exist. This guarantees `VIEWPORT_FILL` expands to ≥4 rows → `fillRows ≥ 4` → sub-region commit is valid (DECSTBM requires ≥2 rows).

**Applied in three places** (all must be consistent):
1. **Scheduler** (`fullscreen-mode.ts`): `transcriptHeight = regions.transcript.height - liveRows - MIN_HISTORY_LANE`
2. **composeFrame** (`fullscreen-mode.ts`): `transcriptHeight = regions.transcript.height - liveRows - 5`
3. **renderChatRegion** (`fullscreen-mode.ts`): `transcriptHeight = regions.transcript.height - liveRows - MIN_HISTORY_LANE_ROWS`

If any site uses the full `regions.transcript.height`, the frame overflows the terminal height → `fillRows = 0` → commit cannot flush.

## CommitFrontier Model

```ts
interface CommitFrontier {
    preludeCommitted: boolean;  // welcome prelude committed to scrollback
    itemIndex: number;          // transcript items [0..itemIndex) committed
}
```

Logical frontier survives width reflow (unlike physical row counts).

## Safety Guards

| Guard | Purpose |
|-------|---------|
| Stable prefix | Commit only items before `computeStablePrefixIndex()`; the streaming tail remains in the live viewport |
| Stale-row defer | Flush waits until the scroll-out rows are blank in the frame model (`commitScrollOutRowsAreBlank`) — layout-shift frames (e.g. launch anchor release) would otherwise push stale pixels into scrollback; retried next frame |
| Queue-gated preview | `withPreviewFrontier` applies only when `queueCommitLines` accepted the rows — refused lanes (zellij/dumb, resize) keep rows on the virtual lane |
| `fillRows >= 2` | Sub-region requires DECSTBM minimum 2 rows |
| `hasNativeCommit` | Ban CSI 3J after first commit (preserve scrollback) |
| `overlayOpen` | Block commits during help/palette/settings |
| `detectHistoryLaneMode` | Skip for TERM=dumb, Zellij |
| Preview frontier | `withPreviewFrontier()` excludes committed rows from render frame |
| Transactional mark | `markCommittedFrontier()` only after confirmed `lastCommitFlushedCount() > 0` |

## Files

| File | Role |
|------|------|
| `src/cli/tui/render/viewport.ts` | CommitFrontier, peekStableCommitRows, withPreviewFrontier, markCommittedFrontier, logical visibleRows |
| `src/cli/tui/render/frame.ts` | queueCommitLines, render-internal sub-region commit flush, hasNativeCommit, detectHistoryLaneMode |
| `bin/commands/tui/fullscreen-mode.ts` | Scheduler integration, computeStablePrefixIndex, MIN_HISTORY_LANE, overlay guard |

## Known Limitations

- **5 fewer transcript rows**: MIN_HISTORY_LANE=5 reserves space for the history lane
- **Whole-item commits**: the running Activity group stays live; earlier stable items can commit after the complete prelude fits the commit range
- **Terminal compatibility**: designed for Ghostty 1.3+; unsupported terminals silently skip commits
- **No commit during overlays**: help/palette/settings screens block commits

## Native Activity presentation

Interactive chat binds semantic events to the server's `activityIdentity` from
`GET /api/orchestrate/snapshot`. `presentation.mode` selects grouped Activity (default)
or linear legacy rows independently of provider native/print transport. Ctrl+O toggles
the latest uncommitted Activity; explicit disclosure survives completion. Raw NDJSON
does not pass through the display projection.

The shared reducer holds bounded previews; the existing assistant transcript owns
the full authoritative answer. Empty and absent answers leave distinct invisible
receipts. Compatibility completion may precede the semantic end, so provisional record
status clears when that end arrives. An actual recording gap remains visible. Exact
retained-run settlement continues during identity refresh without admitting new runs.
Late completions cannot close a newer run's composer or clock.

Commit selection refreshes viewport cells before calculating the frontier. A prelude
that cannot yet fit in the commit range blocks item commitment too: printing welcome
rows must never mark unseen answers committed. Classic linear updates append safe
suffixes; footer repaint saves/restores an open text cursor, while notices close the
line before clearing it. Activity provider text cannot emit VT actions.

At most16 Activity preview models retain text; completed previews release in-place,
preserving transcript indices and uncommitted full answers. Confirmed native flush also
releases committed answer text while retaining its duplicate receipt. Refused/deferred
flushes release nothing; native scrollback pixels stay immutable.

F6 in fullscreen chat opens retained canonical records for one run. Up/Down selects
records, Left/Right selects runs, Enter expands detail, PgUp/PgDn and Home/End scroll,
R reloads and N loads another descriptor batch. One selected run is bounded to4096
records/4MiB; discovery retains256 descriptors per batch. Advancing a batch does not
download every run's payload or move the selected record. Classic chat keeps native
scrollback and directs retained-record inspection to fullscreen mode.

The inspector freezes native commits and preserves the composer draft. Its paste drain
belongs to stdin, survives panel/session reset, and discards the entire remaining paste
before normal key dispatch. F6 cannot take over an active/completing composer paste.
Historical requests are read-only; Enter never submits an approval or model prompt.

Reconnect installs the shared replay buffer before identity refresh and both seed/tail
reads. The256-event/1MiB buffer is independent of the bounded preview. A failed restore
does not publish seeded answers. Full successful replay can clear a local display gap;
known durable gaps remain. Line-mode stdout delivery has its own receipt on the existing
answer row, so buffer failure or a late canonical end cannot hide an already captured
answer. Retired runs cannot regain ownership or republish answers after reset.

## Cell geometry

`cell-width.ts` owns the modern terminal cell policy shared by Activity, generic row
clipping/wrapping, the input box and cursor placement. Measurement uses NFC for Hangul
without changing output text; emoji/ZWJ/flags remain whole clusters and combining marks
do not advance cells. A cluster wider than its entire display area uses a visible `?`
fallback while submitted input remains unchanged.

Styled rows segment visible text once and reinsert CSI at original offsets, including
CSI inside a cluster. Carried SGR is bounded. The classic composer emits the same row
plan used for cursor/row counting, so terminal scalar autowrap cannot erase preceding
output. The supported policy is tested separately from emulator/font variations; raw
NDJSON never enters display sanitization or geometry.

## Research

Full design history at `devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/04_260615_native_scrollback_commit/` (21 documents including 4x GPT Pro audits).
