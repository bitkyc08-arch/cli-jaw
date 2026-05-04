import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, relative, join, sep } from "path";

type StatusClass =
  | "planning"
  | "active"
  | "blocked"
  | "done"
  | "deferred"
  | "unknown"
  | "non_canonical";

type StatusSource = "frontmatter" | "legacy-line" | "missing";

interface ParseResult {
  statusSource: StatusSource;
  rawStatus: string;
  statusClass: StatusClass;
  frontmatterRange: { start: number; end: number } | null;
  legacyLineIndex: number | null;
}

interface Row {
  path: string;
  scope: "plan" | "fin";
  statusSource: StatusSource;
  rawStatus: string;
  statusClass: StatusClass;
  writable: boolean;
}

const EXCLUDE_SEGMENTS = ["reference", "references", "imported", "rag", "front_repo"];
const LEGACY_RE = /^(?:>\s*(?:Status|상태)\s*:|(?:Status|상태)\s*:|\*\*(?:Status|상태)\*\*\s*:)\s*(.+)/i;

function normalize(raw: string): StatusClass {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/^\p{Extended_Pictographic}+\s*/u, "")
    .replace(/^\*+|\*+$/g, "");

  if (!key) return "unknown";
  if (key === "blocked") return "blocked";
  if (key === "plan" || key === "draft" || key === "planning" || key.startsWith("planning")) return "planning";
  if (key === "active" || key === "wip" || key === "in_progress" || key === "in-progress" || key === "in progress" || key.startsWith("in progress")) return "active";
  if (key === "verified" || key === "completed" || key === "done" || key === "done-with-known-gaps" || key.startsWith("done") || key.startsWith("verified") || key.startsWith("completed")) return "done";
  if (key === "deferred" || key === "archived" || key === "abandoned" || key === "superseded") return "deferred";
  return "non_canonical";
}

function isExcluded(filePath: string): boolean {
  const parts = filePath.split(sep);
  return parts.some((p) => EXCLUDE_SEGMENTS.includes(p.toLowerCase()));
}

function walkMarkdown(baseDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(baseDir)) return results;

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const full = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_status_audit.md" && !isExcluded(full)) {
      results.push(full);
    }
  }

  return results;
}

function manifestCandidates(root: string): string[] {
  const manifestPath = resolve(root, "devlog", "structure", "status-scope.json");
  if (!existsSync(manifestPath)) return [];

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as
      | string[]
      | { writable?: unknown; paths?: unknown };

    const rawEntries = Array.isArray(manifest)
      ? manifest.map((item) => (typeof item === "string" ? item : item && typeof item === "object" && "path" in item ? String((item as { path?: unknown }).path ?? "") : ""))
      : Array.isArray(manifest.writable)
        ? manifest.writable
        : Array.isArray(manifest.paths)
          ? manifest.paths
          : [];

    return rawEntries
      .map((rel) => String(rel).trim())
      .filter(Boolean)
      .map((rel) => {
        const normalized = rel.startsWith("devlog/") ? rel : `devlog/${rel.replace(/^\.?\//, "")}`;
        return resolve(root, normalized);
      })
      .filter((filePath) => filePath.includes(`${sep}_fin${sep}`) && !isExcluded(filePath));
  } catch {
    return [];
  }
}

function discoverPaths(root: string): string[] {
  const fromManifest = manifestCandidates(root);
  if (fromManifest.length > 0) return fromManifest.sort();
  return walkMarkdown(resolve(root, "devlog", "_fin")).sort();
}

function parse(content: string): ParseResult {
  const lines = content.split("\n");
  let frontmatterRange: { start: number; end: number } | null = null;
  let frontmatterStatus = "";
  let hasFrontmatterStatus = false;

  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        frontmatterRange = { start: 0, end: i };
        break;
      }
      const match = lines[i]!.match(/^status:\s*(.*)$/i);
      if (match) {
        hasFrontmatterStatus = true;
        frontmatterStatus = (match[1] ?? "").trim();
      }
    }
  }

  if (hasFrontmatterStatus) {
    return {
      statusSource: "frontmatter",
      rawStatus: frontmatterStatus,
      statusClass: normalize(frontmatterStatus),
      frontmatterRange,
      legacyLineIndex: null,
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(LEGACY_RE);
    if (match) {
      const raw = match[1]!.trim();
      return {
        statusSource: "legacy-line",
        rawStatus: raw,
        statusClass: normalize(raw),
        frontmatterRange,
        legacyLineIndex: i,
      };
    }
  }

  return {
    statusSource: "missing",
    rawStatus: "",
    statusClass: "unknown",
    frontmatterRange,
    legacyLineIndex: null,
  };
}

function buildRow(filePath: string, root: string): Row {
  const rel = relative(root, filePath);
  const scope: "plan" | "fin" = rel.includes(`${sep}_fin${sep}`) ? "fin" : "plan";
  const parsed = parse(readFileSync(filePath, "utf8"));

  return {
    path: rel,
    scope,
    statusSource: parsed.statusSource,
    rawStatus: parsed.rawStatus,
    statusClass: parsed.statusClass,
    writable: !isExcluded(filePath),
  };
}

function rewrite(filePath: string): { changed: boolean; detail: string } {
  if (isExcluded(filePath)) {
    return { changed: false, detail: "excluded" };
  }

  const content = readFileSync(filePath, "utf8");
  const parsed = parse(content);

  if (parsed.statusClass === "unknown" || parsed.statusClass === "non_canonical") {
    return { changed: false, detail: `unknown status: ${parsed.rawStatus || "empty"}` };
  }

  const canonical = parsed.statusClass;
  const lines = content.split("\n");

  if (parsed.statusSource === "frontmatter" && parsed.frontmatterRange) {
    for (let i = parsed.frontmatterRange.start + 1; i < parsed.frontmatterRange.end; i++) {
      if (/^status:\s*/i.test(lines[i]!)) {
        const before = lines[i]!;
        lines[i] = `status: ${canonical}`;
        if (before === lines[i]) return { changed: false, detail: "already canonical" };
        writeFileSync(filePath, lines.join("\n"), "utf8");
        return { changed: true, detail: `${parsed.rawStatus} → ${canonical}` };
      }
    }
  }

  if (parsed.statusSource === "legacy-line" && parsed.legacyLineIndex !== null) {
    lines.splice(parsed.legacyLineIndex, 1);
    if (parsed.frontmatterRange) {
      lines.splice(parsed.frontmatterRange.start + 1, 0, `status: ${canonical}`);
    } else {
      lines.unshift("---", `status: ${canonical}`, "---", "");
    }
    writeFileSync(filePath, lines.join("\n"), "utf8");
    return { changed: true, detail: `legacy "${parsed.rawStatus}" → frontmatter ${canonical}` };
  }

  return { changed: false, detail: "no-op" };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--write") ? "write" : "inventory";
  const root = resolve(import.meta.dirname ?? process.cwd(), "..", "..");
  const paths = discoverPaths(root);

  if (paths.length === 0) {
    console.log("No phase documents found.");
    return;
  }

  if (mode === "inventory") {
    const rows = paths.map((p) => buildRow(p, root));
    console.table(rows);
    console.log(`\n${rows.length} files scanned.`);
    return;
  }

  let changed = 0;
  for (const p of paths) {
    const result = rewrite(p);
    const rel = relative(root, p);
    const tag = result.changed ? "UPDATED" : "SKIP";
    console.log(`[${tag}] ${rel} — ${result.detail}`);
    if (result.changed) changed++;
  }
  console.log(`\n${changed}/${paths.length} files updated.`);
}

main();
