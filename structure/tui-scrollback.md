---
created: 2026-06-15
status: active
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
| `overlayOpen` | Block commits during help/palette/settings/F6 history |
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
- **Stable prefix only**: earlier stable items may commit during streaming; unresolved Activity, pending saved-answer reads and streaming rows form a barrier
- **Terminal compatibility**: designed for Ghostty 1.3+; unsupported terminals silently skip commits
- **No commit during overlays**: help/palette/settings/F6 history screens block commits

## Activity and answer lifetime

The scheduler refreshes viewport item identity/content before selecting a commit;
same-index status removal/final insertion cannot reuse stale cached rows. An
uncommitted welcome prelude must fit entirely before item rows advance the frontier.
Queue admission is not delivery: `releaseCommittedActivity` runs only after actual
native flush and keeps stable row/identity/digest receipts while dropping text and
preview maps. Refused commits retain their payloads. Presentation changes and Ctrl+O
affect only uncommitted rows; already emitted scrollback is never rewritten.
Different saved bytes after delivered compatibility get an explicit Updated answer,
while equal digests upgrade provenance without resurrecting released text.

Coupled Activity regressions drive `computeStablePrefixIndex`, Viewport and Screen:
TERM=dumb/Zellij refusal retains payload/frontier; accepted-but-deferred queue
does not release; actual flush releases once; pending answer reads form barriers.
Read-only old-scope F6 selection, live updates, presentation changes and resize keep
the committed sentinel. Actual OS-PTY qualification separately exercises repeated
turns, retained record/long-answer navigation and the Appearance → Legacy write.
Terminal-model tests are not a substitute for that driven surface or font testing.

## Local presentation ownership

TUI rendering uses `src/cli/tui/presentation.ts` and the existing local Markdown,
frame, viewport and Activity layers. It does not initialize an optional renderer,
load Jawcode/Bun bundles or copy their native addon into `dist`. Tool rows retain
local tree indentation and elapsed timing; subagent presentation remains local.
Streaming cursors are added after Markdown layout so a table or closing fence
cannot consume the cursor or change its content. Width and grapheme handling use
the shared ANSI/CJK utilities; the native Activity final stays literal.
