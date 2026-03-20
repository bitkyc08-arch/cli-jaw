# ADR-001: Vite vs esbuild for Frontend Bundling

| Field       | Value                          |
|-------------|--------------------------------|
| **Status**  | Accepted                       |
| **Date**    | 2026-03-20                     |
| **Authors** | cli-jaw maintainers            |
| **Issue**   | #82                            |

## Context

cli-jaw has a web UI served by Express (`public/`, ~4,100 lines of TypeScript across
19 modules). The frontend was bundled with esbuild since 2026-02-25 (see
`devlog/_fin/260225_esbuild_번들러_도입.md`). A Vite migration was proposed as P1 in the
frontend modernization roadmap (`devlog/_plan/future_feature/260227_frontend_modernization/plan.md`)
and evaluated during the vanilla-to-TS migration (`devlog/_fin/260226_vanilla_to_ts/plan.md`).

This ADR consolidates those analyses into a single decision record.

### Current Architecture

```
index.html
  ├── <script defer> × 5  (CDN: marked, hljs, KaTeX, Mermaid, DOMPurify → window globals)
  └── <script type="module" src="/dist/bundle.js">  ← esbuild single bundle

Express server.ts
  └── express.static('public/')  ← serves frontend + API in one process
```

- **Dev**: `tsx server.ts` — Express serves everything; no separate frontend dev server.
- **Build**: `node esbuild.config.mjs` → `public/dist/bundle.js` (92 KB minified, 16ms build).
- **Watch**: `node esbuild.config.mjs --watch` — rebuilds on save, manual browser refresh.
- **Config size**: 24 lines (`esbuild.config.mjs`).

### What Vite Would Add

Vite's primary value proposition is **HMR (Hot Module Replacement)** — instant in-browser
updates without full page reload. Secondary benefits include a richer plugin ecosystem and
Rollup-based production builds.

## Decision

**Keep esbuild. Do not migrate to Vite.**

## Rationale

### Comparison

| Criterion              | esbuild (current)                              | Vite (proposed)                                      |
|------------------------|-------------------------------------------------|------------------------------------------------------|
| **Config complexity**  | 24 lines, zero plugins                          | `vite.config.ts` + HMR proxy + CDN externals config  |
| **TypeScript**         | ✅ Native TS transform (esbuild IS a TS parser) | ✅ Native (uses esbuild internally)                   |
| **Type checking**      | Separate `tsc --noEmit` (same either way)       | Same — Vite does not type-check either                |
| **HMR**               | ❌ Watch mode only, manual refresh               | ✅ CSS/JS hot reload                                  |
| **CDN libs**           | ✅ Working as-is (global `<script defer>`)       | ⚠️ Needs `optimizeDeps.exclude` + `rollupOptions.external` |
| **Express integration**| ✅ Decoupled — build is independent              | ⚠️ Dev needs Vite proxy → Express (two processes)     |
| **Dev server**         | Single Express process                          | Vite dev + Express backend = two processes            |
| **Build speed**        | 16ms                                            | ~comparable (uses esbuild internally)                 |
| **Bundle size**        | 92 KB (already minified)                        | Marginally smaller via Rollup tree-shaking (negligible)|
| **New dependencies**   | 0                                               | `vite` + potential `@vitejs/plugin-*`                 |
| **Migration effort**   | 0                                               | ~2-3 hours + testing all CDN globals                  |

### Why HMR Doesn't Justify the Switch

1. **Single-process architecture.** Express serves frontend and backend together.
   Adding Vite dev server means running two processes and configuring proxy rules
   for `/api` and `/ws` (WebSocket) — complexity that doesn't exist today.

2. **CDN globals require special handling.** Five libraries load via `<script defer>`
   and expose window globals (`window.marked`, `window.hljs`, etc.). Vite's module
   resolution would need explicit exclusions, and the `index.html` would need
   conditional script loading between dev and production modes.

3. **Codebase size doesn't demand HMR.** At ~4,100 lines / 19 files, a full page
   reload after esbuild watch rebuild (16ms) takes under 1 second. HMR saves
   seconds per reload — meaningful for large SPAs, marginal here.

4. **Principle of minimal dependencies.** The project's `dev/SKILL.md` emphasizes
   keeping dependencies minimal. esbuild is already a devDependency; Vite would
   add another layer on top of the same tool.

### When to Reconsider

Re-evaluate this decision if any of these conditions change:

- Frontend grows beyond ~10,000 lines or adopts a component framework (React, Svelte, etc.)
- The project adds CSS preprocessing (Sass/PostCSS) that benefits from Vite plugins
- Express is replaced or decoupled from frontend serving (e.g., separate static hosting)
- HMR becomes critical due to frequent UI iteration cycles

## Consequences

### Positive

- **Zero migration cost.** No config changes, no new dependencies, no risk of breaking CDN globals.
- **Single-process dev.** `tsx server.ts` + `watch:frontend` is the entire dev setup.
- **Sub-second feedback loop.** 16ms build + manual refresh is fast enough for the current scale.
- **Reduced decision fatigue.** One bundler (esbuild), one way to build.

### Negative

- **No HMR.** Developers must manually refresh the browser after frontend changes.
- **No Vite plugin ecosystem.** Future needs (e.g., CSS modules, asset hashing) would require
  manual esbuild plugins or reconsidering Vite.
- **Watch mode is basic.** No error overlay in the browser — errors appear only in terminal.

### Neutral

- **TypeScript support is identical.** Both tools use esbuild for TS transformation; neither type-checks.
  The project already runs `tsc --noEmit` separately.

## References

- `esbuild.config.mjs` — current 24-line build config
- `devlog/_fin/260225_esbuild_번들러_도입.md` — original esbuild adoption record
- `devlog/_fin/260226_vanilla_to_ts/plan.md` — first esbuild vs Vite comparison (§ 번들러 검토)
- `devlog/_plan/future_feature/260227_frontend_modernization/plan.md` — Vite listed as P1 (superseded by this ADR)
