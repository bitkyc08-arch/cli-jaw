# Manager Notes Obsidian-Style Markdown Roadmap

Created: 2026-05-02

## Current Position

Manager Notes is a Markdown file editor with Raw, Split, Preview, and WYSIWYG
surfaces. It is not an Obsidian clone yet. The supported core is CommonMark plus
safe GFM, math, code highlighting, Mermaid preview rendering, and scoped
WYSIWYG node views for richer source editing.

The main safety rule remains unchanged: do not re-enable unsafe Milkdown task
list parsing paths. Native GFM task-list input rules and direct Milkdown task
node creation have repeatedly frozen the dashboard in browser smoke. Task
markers must stay on the protected Markdown-boundary path until a separate
non-freezing implementation is proven.

## Grok Research Summary

Grok reviewed the WYSIWYG heading-source-edit request and confirmed the safe
path: implement editable raw heading markers through a small, bounded Milkdown
heading node view. This follows the existing `notesMilkdownCodeBlockView` and
`notesMilkdownMath` pattern, avoids global listeners, leaves parser and
serializer behavior unchanged, and updates only the heading `level` attribute.

Rejected approaches:

- Editable decoration widgets for the `#` prefix, because editable widgets
  require fragile `stopEvent` and mutation handling.
- Input rules or keymaps alone, because they do not solve click-to-edit source
  marker UX.
- Full source-mode swaps, because that replaces the editor surface instead of
  extending the existing WYSIWYG architecture.
- Any task-list implementation that asks Milkdown to parse native GFM task
  nodes on the live WYSIWYG path.

## Phase 1: Bounded WYSIWYG Affordances

### Editable Heading Markers

Status: implemented locally, pending browser smoke.

Files:

- `public/manager/src/notes/wysiwyg/milkdown-heading-source-view.ts`
- `public/manager/src/notes/wysiwyg/MilkdownWysiwygEditor.tsx`
- `public/manager/src/manager-notes.css`
- `tests/unit/manager-notes-editor-contract.test.ts`

Behavior:

- WYSIWYG headings render a subtle `#` marker input next to the heading text.
- The marker appears on hover, focus, node selection, or active marker editing.
- Editing `#` through `######` changes heading level 1 through 6.
- Clearing the marker downgrades the heading to a paragraph.
- Markdown serialization still uses normal heading syntax.

Verification required before shipping:

- TypeScript frontend check.
- Manager notes editor contract tests.
- Frontend build.
- Browser smoke: click a WYSIWYG heading, edit `#` count, confirm heading level
  changes, text remains, undo/redo works, and no dashboard freeze occurs.

### Callouts

Candidate syntax:

```md
> [!note]
> Body
```

Recommended approach:

- Preview first: render Obsidian-style callouts in `MarkdownRenderer` by
  detecting blockquote content that starts with `[!kind]`.
- WYSIWYG second: add a bounded blockquote/callout node view only after preview
  rendering is stable.
- Keep raw Markdown canonical and avoid proprietary hidden state.

Likely files:

- `public/manager/src/notes/rendering/MarkdownRenderer.tsx`
- `public/manager/src/notes/rendering/markdown-render-security.ts`
- `public/manager/src/manager-notes.css`
- Future: `public/manager/src/notes/wysiwyg/milkdown-callout-view.ts`

Risk: low to medium. Preview rendering is low risk; WYSIWYG block node views
need smoke coverage.

### Mermaid Source Widgets

Current state:

- Mermaid fenced blocks render in Preview.
- WYSIWYG currently benefits from the code block source view rather than a
  dedicated Mermaid rendered/source toggle.

Recommended approach:

- Extend `notesMilkdownCodeBlockView` for `language === 'mermaid'`.
- Provide rendered preview plus raw source editing, following the existing code
  block node view cleanup and commit patterns.
- Keep invalid diagrams editable and non-fatal.

Likely files:

- `public/manager/src/notes/wysiwyg/milkdown-code-block-view.ts`
- `public/manager/src/notes/rendering/MermaidBlock.tsx`
- `public/manager/src/manager-notes.css`

Risk: medium. Mermaid render lifecycle and async errors must not block editor
typing or focus.

## Phase 2: Markdown Extensions With Roundtrip Risk

### Wiki Links

Candidate syntax:

```md
[[Note]]
[[Note|Alias]]
```

Recommended approach:

- Start with Preview rendering and Raw/rich CodeMirror decorations.
- Add WYSIWYG mark or inline node only after parse/serialize fixtures pass.
- Resolve targets against the existing notes tree, but keep unresolved links
  visible and editable.

Likely files:

- `public/manager/src/notes/rendering/MarkdownRenderer.tsx`
- `public/manager/src/notes/rich-markdown/rich-markdown-extension.ts`
- Future: `public/manager/src/notes/wysiwyg/milkdown-wiki-link.ts`
- Future: `public/manager/src/notes/wiki-links.ts`

Risk: high. It adds custom parse/serialize behavior and navigation semantics.

### Embeds

Candidate syntax:

```md
![[Note]]
![[image.png]]
```

Recommended approach:

- Defer live WYSIWYG embeds until wiki link parsing is stable.
- Preview can show safe note/image embeds with strict path guards.
- Never render arbitrary HTML from embedded notes.

Risk: high. Needs path security, recursion limits, and cycle detection.

### Frontmatter And Properties

Candidate syntax:

```md
---
title: Example
tags: [alpha]
---
```

Recommended approach:

- Preserve raw YAML frontmatter first.
- Add a small properties panel later, backed by a parser that roundtrips
  unknown keys and formatting conservatively.
- Avoid making WYSIWYG parse frontmatter as normal body content.

Risk: high. Lossless roundtrip is the hard part.

### Block References

Candidate syntax:

```md
Paragraph text ^block-id
```

Recommended approach:

- Start as Preview anchors and search-index metadata.
- Add WYSIWYG inline affordances only after link/backlink indexing exists.

Risk: high. It couples editor content, navigation, and indexing.

## Phase 3: Index-Backed Obsidian Features

### Tags And Backlinks

Recommended approach:

- Build a note index outside the editor first.
- Support `#tag` scanning, wiki-link backlinks, and quick navigation.
- Keep indexing incremental and resilient to malformed Markdown.

Likely files:

- Future: `public/manager/src/notes/notes-index.ts`
- Future: backend note scan/index APIs if indexing moves server-side.

Risk: very high. Performance and stale-index behavior matter more than editor
rendering.

### Graph View

Recommended approach:

- Defer until wiki links and backlinks are stable.
- Use index data, not live editor DOM, as the source of truth.

Risk: very high.

## Phase 4: Deferred Plugin-Grade Features

### Dataview-Like Queries

Recommended approach:

- Treat as a separate query engine, not a Markdown renderer feature.
- Require sandboxing, execution limits, clear error states, and explicit user
  opt-in.

Risk: extreme. This is out of scope for core editor stability.

### Plugin Ecosystem

Recommended approach:

- Defer. Manager Notes should first stabilize fixed, audited Markdown extensions.
- A plugin API would need permission, security, and lifecycle boundaries.

Risk: extreme.

## Verification Bar

Each feature should pass this minimum bar before being considered done:

- `npm run typecheck:frontend`
- Targeted manager notes unit/contract tests.
- `npm run build:frontend`
- Browser smoke in the real dashboard surface.
- Regression smoke for task marker safe mode, code block source view, math node
  view, Preview rendering, and note scroll behavior.

