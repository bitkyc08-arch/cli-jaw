# Manager Notes WYSIWYG Task Safety

Created: 2026-05-02

## Incident

Typing a GFM task marker such as `- [ ]` in Manager Notes WYSIWYG could freeze the
dashboard renderer hard enough that reopening `jaw dashboard` still landed on the
same unusable notes state. The recovery path reset the dashboard registry to a
plain instance view, then the WYSIWYG task path was isolated.

## Grok Pro Review

Grok Pro reviewed the patch direction through `agbrowse web-ai` on 2026-05-02.
The first verdict was `NEEDS_FIX`: removing the unsafe live input rule was the
right safety direction, but the patch also needed a task creation fallback,
clear cleanup guarantees, canonical marker normalization, and blocking tests.

The patch therefore keeps task-list support without reinstalling Milkdown's
`wrapInTaskListInputRule`:

- Use a local GFM wrapper that preserves schema, commands, paste rules, keymap,
  and plugins, but filters out `wrapInTaskListInputRule`.
- Convert escaped literal task markers only at the Markdown boundary, not during
  live typing.
- Keep the toolbar `Task` action disabled until a safe non-freezing command path
  exists. Multiple command-based insertion attempts re-entered Milkdown task/list
  conversion and froze the renderer.
- Keep existing loaded task nodes interactive with one root click listener, one
  captured keydown listener, and one MutationObserver scoped to child changes and
  `data-checked`.

## Leak And Performance Boundaries

The implementation is intentionally small and bounded:

- No polling, intervals, global listeners, or per-task DOM listeners.
- The MutationObserver is created only after the editor is ready and is
  disconnected in the effect cleanup.
- Both root event listeners are removed with the same capture options used when
  registered.
- The Milkdown editor instance is destroyed in the creation effect cleanup.
- Normalization is a single line-based regex over the serialized Markdown.
  Document replacement is not used for task marker typing or toolbar insertion.

## Behavior Contract

- Typing `- [ ]` in WYSIWYG must not freeze the dashboard.
- Saving typed literal task markers must produce canonical GFM task Markdown.
- The toolbar `Task` button must not trigger a renderer freeze. It is disabled
  for now.
- Reloaded GFM task Markdown must render as task nodes and remain clickable and
  keyboard-toggleable.
- Preview mode must continue to render GFM task checkboxes through the shared
  Markdown renderer.

## Verification

Run these before shipping changes in this area:

```bash
npx tsx --import ./tests/setup/test-home.ts --experimental-test-module-mocks --test tests/unit/manager-notes-editor-contract.test.ts tests/unit/manager-notes-rendering-contract.test.ts
npm run typecheck:frontend
npm run typecheck
npm run build:frontend
```

For browser smoke, use a real dashboard instance and verify:

- `/dashboard` loads after restarting `jaw dashboard`.
- WYSIWYG accepts `- [ ] test` without a renderer freeze.
- The toolbar `Task` button creates a visible checkbox.
- Preview renders `- [ ]` and `- [x]` as disabled checkboxes.
