# Memory Architecture

> Internal reference for the cli-jaw memory runtime.
> Source of truth: `src/memory/runtime.ts`

---

## 1. Overview

cli-jaw uses a **structured, file-based memory system** backed by Markdown files and a
SQLite FTS5 full-text index. Every JAW_HOME instance gets its own `memory/structured/`
tree that is created on first use and persists across sessions.

There are two layers:

| Layer        | Module                   | Role                                         |
|--------------|--------------------------|----------------------------------------------|
| **Legacy**   | `src/memory/memory.ts`   | grep-based search over `memory/MEMORY.md` and flat `.md` files |
| **Indexed**  | `src/memory/runtime.ts`  | Chunked FTS5 index, profile summary, task snapshots             |

When the indexed layer is ready (`routing.searchRead === 'advanced'`), all search/read
operations are routed through it. The legacy layer remains as a fallback during
initialization.

---

## 2. Storage Layout

All paths are relative to `JAW_HOME` (e.g. `~/.cli-jaw-XXXX`).

```
memory/
├── MEMORY.md                        ← legacy core memory (User Preferences / Key Decisions / Active Projects)
└── structured/                      ← getAdvancedMemoryDir()  →  JAW_HOME/memory/structured
    ├── meta.json                    ← AdvancedMeta — schema version, bootstrap status, import counts
    ├── index.sqlite                 ← FTS5 index (chunks + chunks_fts tables)
    ├── .migration.lock              ← transient lock file during migration
    ├── profile.md                   ← imported/generated profile (kind: profile)
    ├── shared/                      ← cross-session shared memories (kind: shared)
    ├── episodes/                    ← time-stamped memories (kind: episode)
    │   ├── live/                    ←   flush target — today's date file (YYYY-MM-DD.md)
    │   ├── daily/                   ←   auto-log entries from appendDaily()
    │   ├── imported/                ←   legacy markdown imports (dated files)
    │   └── legacy/                  ←   Claude session memory imports
    ├── semantic/                    ← concept-based memories (kind: semantic)
    │   ├── imported/                ←   non-dated legacy markdown imports
    │   └── kv-imported.md           ←   KV table dump from jaw.db
    ├── procedures/                  ← how-to / runbook memories (kind: procedure)
    ├── sessions/                    ← session-scoped scratch (kind: session)
    ├── corrupted/                   ← quarantined files
    └── legacy-unmapped/             ← files that couldn't be classified

backup-memory-v1/                    ← getAdvancedMemoryBackupDir()  →  JAW_HOME/backup-memory-v1
├── memory/                          ←   full copy of legacy memory/ tree
└── memory-kv.json                   ←   JSON dump of the KV table
```

### Key path helpers

| Function                        | Returns                                                |
|---------------------------------|--------------------------------------------------------|
| `getAdvancedMemoryDir()`        | `JAW_HOME/memory/structured`                           |
| `getAdvancedMemoryBackupDir()`  | `JAW_HOME/backup-memory-v1`                            |
| `getAdvancedFlushFilePath(date)`| `JAW_HOME/memory/structured/episodes/live/<date>.md`   |

### Legacy path (pre-migration)

Before the structured layout existed, a standalone `memory-advanced/` directory sat at
`JAW_HOME/memory-advanced`. `migrateLegacyAdvancedRoot()` copies it into
`memory/structured/` on first run if the new root is empty.

---

## 3. Metadata (`meta.json`)

The `AdvancedMeta` type tracks runtime state:

```typescript
type AdvancedMeta = {
  schemaVersion: number;           // always 1
  phase: string;                   // "10" (current)
  homeId: string;                  // instanceId() — unique per JAW_HOME
  jawHome: string;                 // absolute path
  initializedAt: string;           // ISO timestamp
  migrationVersion?: number;       // 1
  migrationState?: 'pending' | 'running' | 'done' | 'failed';
  migratedAt?: string | null;
  sourceLayout?: 'legacy' | 'advanced' | 'structured';
  bootstrapStatus?: 'idle' | 'running' | 'done' | 'failed';
  lastBootstrapAt?: string | null;
  lastError?: string;
  importedCounts?: {
    core: number;      // from MEMORY.md → profile.md
    markdown: number;  // from memory/*.md → episodes/ or semantic/
    kv: number;        // from jaw.db memory table → semantic/kv-imported.md
    claude: number;    // from ~/.claude/projects/…/memory → episodes/legacy/
  };
};
```

Written by `writeMeta(patch)` (merges with existing).
Read by `readMeta()`.

---

## 4. Bootstrap Flow

Entry point: **`ensureIntegratedMemoryReady()`** — called once at startup.

```
ensureIntegratedMemoryReady()
  │
  ├─ ensureAdvancedMemoryStructure()
  │    ├─ withMigrationLock()
  │    ├─ migrateLegacyAdvancedRoot()        ← copies memory-advanced/ → memory/structured/
  │    ├─ create all subdirectories           (shared, episodes, semantic, procedures, sessions, corrupted, legacy-unmapped)
  │    ├─ writeMeta()                         ← schemaVersion 1, phase 10
  │    └─ create empty profile.md if missing
  │
  ├─ getAdvancedMemoryStatus()
  │    └─ if indexState === 'ready' → return early (already bootstrapped)
  │
  ├─ detect legacy sources?
  │    ├─ NO  → reindexAdvancedMemory() → return
  │    └─ YES ↓
  │
  └─ bootstrapAdvancedMemory()
       ├─ backupLegacyMemory()               ← full copy to backup-memory-v1/
       ├─ importCoreMemory()                  ← MEMORY.md → profile.md
       ├─ importMarkdownMemory()              ← memory/*.md → episodes/imported or semantic/imported
       ├─ importKvMemory()                    ← jaw.db KV rows → semantic/kv-imported.md
       ├─ importClaudeSessionMemory()         ← ~/.claude/projects/…/memory → episodes/legacy/
       ├─ reindexAll()                        ← chunk all files → index.sqlite
       └─ writeMeta(bootstrapStatus: 'done')
```

### Import sources

| Source                    | Importer                      | Destination                         | Kind       |
|---------------------------|-------------------------------|-------------------------------------|------------|
| `memory/MEMORY.md`       | `importCoreMemory()`          | `structured/profile.md`            | `profile`  |
| `memory/**/*.md` (dated) | `importMarkdownMemory()`      | `structured/episodes/imported/…`   | `episode`  |
| `memory/**/*.md` (other) | `importMarkdownMemory()`      | `structured/semantic/imported/…`   | `semantic` |
| jaw.db `memory` table    | `importKvMemory()`            | `structured/semantic/kv-imported.md`| `semantic` |
| `~/.claude/projects/…`   | `importClaudeSessionMemory()` | `structured/episodes/legacy/…`     | `episode`  |

Each imported file gets YAML frontmatter with `id`, `home_id`, `kind`, `source`, `trust_level`,
`source_hash`, and timestamps.

---

## 5. Indexing

### SQLite schema (`index.sqlite`)

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,             -- absolute file path
  relpath TEXT NOT NULL,          -- relative to structured/ root
  kind TEXT NOT NULL,             -- profile | shared | episode | semantic | procedure
  home_id TEXT NOT NULL DEFAULT '',
  source_start_line INTEGER NOT NULL,
  source_end_line INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  relpath UNINDEXED,
  kind UNINDEXED,
  tokenize = 'unicode61'
);
```

### Chunking strategy

`chunkMarkdown(absPath, relpath, kind)` splits each `.md` file into chunks by
`#`/`##`/`###` headings. Each chunk includes:

- A metadata prefix: `Source: <relpath>`, `Kind: <kind>`, `Header: <heading path>`
- The body text under that heading

Frontmatter is stripped before chunking.

### Which files are indexed

`indexedFiles(root)` collects from these locations (in order):

1. `profile.md` (root level)
2. `shared/**/*.md`
3. `episodes/**/*.md`
4. `semantic/**/*.md`
5. `procedures/**/*.md`

Files in `sessions/`, `corrupted/`, and `legacy-unmapped/` are **not** indexed.

### Reindex operations

| Function                               | Scope                        | When used                              |
|-----------------------------------------|------------------------------|----------------------------------------|
| `reindexAdvancedMemory()`              | Full rebuild (all files)     | Bootstrap, manual `reindex` command    |
| `reindexIntegratedMemoryFile(file)`    | Single file                  | After `memory save` to structured/     |

`reindexAll()` runs inside a transaction: clears all rows, then re-chunks and inserts.
`reindexSingleFile()` deletes existing chunks for that relpath, then re-inserts.

---

## 6. Search Flow

Entry point: **`searchAdvancedMemory(query)`**

```
searchAdvancedMemory(query)
  │
  ├─ normalize query → string or string[]
  │
  └─ searchIndex(baseQuery, expanded?)
       │
       ├─ tokenizeExpandedQuery()     ← up to 8 terms (query + expanded keywords)
       │
       ├─ for each term:
       │    ├─ FTS5 MATCH (bm25 scoring, limit 16)
       │    └─ LIKE fallback (limit 16)
       │
       ├─ deduplicate by relpath:start_line:end_line
       │
       └─ sort by score, take top 8 → formatHits()
```

### Keyword expansion

`expandSearchKeywords(query)` generates additional search terms:

1. **Heuristic** (`heuristicKeywords`): tokenizes the query and adds known synonyms
   (e.g. `login` → `auth`, `인증`, `401`; `launchd` → `plist`, `service`)
2. **LLM-assisted** (optional, not called by default in `expandSearchKeywords`):
   - `expandViaGemini()` — Gemini API
   - `expandViaOpenAiCompatible()` — OpenAI-compatible endpoint
   - `expandViaVertex()` — Vertex AI with service account JWT auth

The expansion result is stored in `lastExpansionTerms` and surfaced in
`getAdvancedMemoryStatus().lastExpansion`.

### Output format

`formatHits()` renders each hit as:

```
<relpath>:<start_line>-<end_line>
<snippet (max 700 chars)>

---

```

---

## 7. Read Flow

### `readAdvancedMemorySnippet(relPath, opts?)`

Reads a file from `structured/` by relative path. Supports `opts.lines` as `"from-to"`
for line-range extraction.

### `loadAdvancedProfileSummary(maxChars = 800)`

Reads `profile.md`, strips frontmatter, returns the body (truncated if > 800 chars).
Used for prompt injection.

---

## 8. Save Flow

Saving is handled by the legacy `memory.ts` module, which delegates to the runtime
for indexing:

```
memory.save(filename, content)
  │
  ├─ append content to JAW_HOME/memory/<filename>
  │
  └─ async post-save hook:
       ├─ if filename starts with "structured/" → reindexIntegratedMemoryFile()
       └─ else → syncLegacyMarkdownShadowImport()
```

### Shadow import (legacy → structured)

When a file is saved to the legacy `memory/` tree:

- **`syncLegacyMarkdownShadowImport(file)`** copies it into `structured/episodes/imported/`
  or `structured/semantic/imported/` (based on whether the filename is date-shaped), then
  reindexes the new file.
- **Special case**: if the file is `memory/MEMORY.md`, it re-imports into `profile.md`
  via `importCoreMemory()`.
- **`syncKvShadowImport()`** re-dumps all KV rows into `semantic/kv-imported.md` and
  reindexes.

This means legacy saves are **automatically mirrored** into the structured index.

---

## 9. Prompt Injection

The system prompt builder (`src/prompt/builder.ts`) injects memory context based on
routing state:

```
getSystemPrompt(opts)
  │
  ├─ getMemoryStatus()
  │
  ├─ if routing.searchRead === 'advanced':
  │    └─ appendAdvancedMemoryContext()
  │         ├─ loadProfileSummary(800)        ← profile.md body
  │         └─ buildTaskSnapshot(prompt, 2800) ← FTS search using current prompt
  │
  └─ else (fallback):
       └─ appendLegacyMemoryContext()          ← raw MEMORY.md content
```

### Task snapshot

`buildTaskSnapshot(query, budget = 2800, expanded?)` searches the index using the
current user prompt and returns a budget-limited digest:

- Takes top 4 hits
- Formats as `### <relpath>:<lines>\n<snippet>` blocks
- Wraps in a `## Task Snapshot` section
- Each snippet capped at 700 chars, total capped at `budget` chars

`buildTaskSnapshotAsync()` is a thin async wrapper (currently synchronous internally).

---

## 10. Status Reporting

**`getAdvancedMemoryStatus()`** returns a comprehensive status object:

```typescript
{
  phase: string;                       // "10"
  enabled: boolean;                    // always true
  provider: string;                    // "integrated"
  state: 'configured' | 'not_initialized';
  initialized: boolean;
  storageRoot: string;                 // absolute path to structured/
  routing: {
    searchRead: 'advanced' | 'basic';  // advanced when index.sqlite exists
    save: 'integrated';
  };
  indexState: 'ready' | 'not_indexed' | 'not_initialized';
  indexedFiles: number;
  indexedChunks: number;
  lastIndexedAt: string | null;
  importStatus: string;               // bootstrapStatus from meta
  corruptedCount: number;
  lastExpansion: string[];             // last keyword expansion terms
  lastError: string;
  importedCounts: { core, markdown, kv, claude };
  backupRoot: string;
}
```

This is exposed via:
- `cli-jaw memory status` (CLI)
- `command-context.ts` → `getAdvancedMemoryStatus()`
- `getMemoryStatus()` alias

---

## 11. Exported Functions Reference

### Path helpers

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `getAdvancedMemoryDir`         | `() → string`                                         | `JAW_HOME/memory/structured`        |
| `getAdvancedMemoryBackupDir`   | `() → string`                                         | `JAW_HOME/backup-memory-v1`         |
| `getAdvancedFlushFilePath`     | `(date?: string) → string`                            | Today's live episode file           |

### Config & validation

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `normalizeOpenAiCompatibleBaseUrl` | `(raw: string) → string`                          | Ensures URL ends with `/v1`         |
| `expandSearchKeywords`         | `(query: string) → Promise<string[]>`                 | Heuristic keyword expansion         |
| `validateAdvancedMemoryConfig` | `(override?) → Promise<{ok, provider, error}>`        | Validates embedding provider config |

### Lifecycle

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `ensureAdvancedMemoryStructure`| `() → {root, metaPath, profilePath}`                  | Create dirs + meta + profile        |
| `bootstrapAdvancedMemory`      | `(options?: BootstrapOptions) → BootstrapResult`      | Full import + index from scratch    |
| `ensureIntegratedMemoryReady`  | `() → {created, bootstrapped, status, result?}`       | One-shot startup initialization     |

### Indexing

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `reindexAdvancedMemory`        | `() → {totalFiles, totalChunks}`                      | Full reindex of all structured files|
| `reindexIntegratedMemoryFile`  | `(file: string) → number`                             | Single-file reindex                 |

### Shadow sync

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `syncLegacyMarkdownShadowImport`| `(file: string) → {ok, target?, count?, reason?}`    | Import legacy .md → structured      |
| `syncKvShadowImport`          | `() → {ok, target?, count?, reason?}`                  | Re-import KV table → structured     |

### Query & read

| Export                          | Signature                                             | Purpose                              |
|---------------------------------|-------------------------------------------------------|--------------------------------------|
| `listAdvancedMemoryFiles`      | `() → {root, sections}`                               | List all files by section           |
| `searchAdvancedMemory`         | `(query: string\|string[]) → string`                  | FTS + LIKE search, formatted output |
| `loadAdvancedProfileSummary`   | `(maxChars?: number) → string`                        | Profile body for prompt injection   |
| `buildTaskSnapshot`           | `(query, budget?, expanded?) → string`                 | Budget-limited search digest        |
| `buildTaskSnapshotAsync`      | `(query, budget?) → Promise<string>`                   | Async wrapper for task snapshot     |
| `readAdvancedMemorySnippet`   | `(relPath, opts?) → string\|null`                      | Read file by relpath                |
| `getAdvancedMemoryStatus`     | `() → AdvancedMemoryStatus`                            | Full status report                  |

### Re-exported aliases (bottom of runtime.ts)

| Alias                       | Original                          |
|-----------------------------|-----------------------------------|
| `getStructuredMemoryDir`    | `getAdvancedMemoryDir`           |
| `getMemoryBackupDir`        | `getAdvancedMemoryBackupDir`     |
| `getMemoryFlushFilePath`    | `getAdvancedFlushFilePath`       |
| `ensureMemoryStructure`     | `ensureAdvancedMemoryStructure`  |
| `bootstrapMemory`           | `bootstrapAdvancedMemory`        |
| `ensureMemoryRuntimeReady`  | `ensureIntegratedMemoryReady`    |
| `reindexMemory`             | `reindexAdvancedMemory`          |
| `listMemoryFiles`           | `listAdvancedMemoryFiles`        |
| `searchIndexedMemory`       | `searchAdvancedMemory`           |
| `readIndexedMemorySnippet`  | `readAdvancedMemorySnippet`      |
| `getMemoryStatus`           | `getAdvancedMemoryStatus`        |
| `loadProfileSummary`        | `loadAdvancedProfileSummary`     |

---

## 12. Module Relationships

```
                          ┌──────────────────────┐
                          │   prompt/builder.ts   │
                          │  appendAdvancedMemory │
                          │  Context()            │
                          └───────┬───────────────┘
                                  │ calls loadProfileSummary(),
                                  │       buildTaskSnapshot()
                                  ▼
┌──────────────┐          ┌──────────────────────┐
│  memory.ts   │ ──hook──▶│    runtime.ts         │
│  (legacy)    │          │  (indexed runtime)    │
│  save/search │          │  bootstrap, index,    │
│  read/list   │          │  search, read, status │
└──────────────┘          └───────┬───────────────┘
                                  │
                          ┌───────▼───────────────┐
                          │  command-context.ts    │
                          │  CLI command bindings  │
                          │  searchMemory(),       │
                          │  getAdvancedMemory     │
                          │  Status(), etc.        │
                          └───────────────────────┘
```

- `memory.ts` handles user-facing `save`/`search`/`read`/`list` commands
- On save, it async-imports `runtime.ts` for shadow sync / reindex
- `runtime.ts` owns the structured tree, FTS index, bootstrap, and status
- `prompt/builder.ts` injects profile + task snapshot into the system prompt
- `command-context.ts` exposes runtime functions to CLI commands

---

## 13. Concurrency & Locking

- **Migration lock**: `withMigrationLock()` uses a `.migration.lock` file to prevent
  concurrent structure initialization. Non-blocking — if lock exists, the operation
  proceeds anyway (stale lock tolerance).
- **SQLite WAL mode**: `index.sqlite` uses WAL for concurrent read safety.
- **Single-file reindex**: deletes then re-inserts within a transaction, safe for
  concurrent readers.

---

## 14. Configuration

The `AdvancedConfig` type supports multiple embedding/expansion providers, but the
current default is `provider: 'integrated'` which uses no external API for search —
all search is local FTS5 + LIKE.

Provider options (for keyword expansion only, not search):

| Provider     | Config fields                              | Function              |
|--------------|--------------------------------------------|-----------------------|
| `gemini`     | `apiKey`, `model`                          | `expandViaGemini()`   |
| `openai`     | `apiKey`, `baseUrl`, `model`               | `expandViaOpenAiCompatible()` |
| `vertex`     | `vertexConfig` (JSON with SA credentials)  | `expandViaVertex()`   |
| `integrated` | (none — heuristic only)                    | `heuristicKeywords()` |
