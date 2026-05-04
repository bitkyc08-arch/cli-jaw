#!/usr/bin/env bash
# audit-fin-status.sh — Classify _fin/ phase docs by status metadata.
# Exit: 0 = clean, 1 = runtime error, 2 = planning/active/blocked leakage, 3 = strict-mode failure
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

FIN_DIR="devlog/_fin"
PLAN_DIR="devlog/_plan"
REPORT_FILE="$FIN_DIR/_status_audit.md"

STRICT=false
MOVE_PLANNING=false
for arg in "$@"; do
  case "$arg" in
    --strict)        STRICT=true ;;
    --move-planning) MOVE_PLANNING=true ;;
  esac
done

# ── Canonical vocabulary ────────────────────────────────────────────
normalize_status() {
  local raw="$1"
  local lower
  lower="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//; s/^\*\+//; s/\*\+$//; s/^✅[[:space:]]*//')"
  case "$lower" in
    planning|plan|draft|planning-v4.1|planning*)        echo "planning" ;;
    active|in_progress|in-progress|in\ progress|wip|in\ progress*)    echo "active" ;;
    blocked)                                            echo "blocked" ;;
    done|verified|completed|done-with-known-gaps|done*|verified*|completed*)       echo "done" ;;
    deferred|archived|abandoned|superseded)             echo "deferred" ;;
    "")                                                 echo "unknown" ;;
    *)                                                  echo "non_canonical" ;;
  esac
}

# ── Status extractor (frontmatter > legacy line > missing) ──────────
extract_status() {
  local file="$1"
  local raw="" source="missing"

  # 1. Try YAML frontmatter  status:
  if head -1 "$file" | grep -q '^---'; then
    raw="$(awk '
      NR==1 && /^---/ { in_fm=1; next }
      in_fm && /^---/ { exit }
      in_fm && /^status:/ { sub(/^status:[[:space:]]*/, ""); print; exit }
    ' "$file")"
    if [[ -n "$raw" ]]; then
      source="frontmatter"
    fi
  fi

  # 2. Fallback: legacy status lines in first 40 lines
  if [[ -z "$raw" ]]; then
    raw="$(head -40 "$file" | sed -n '
      s/^> *Status:[[:space:]]*//p
      s/^> *상태:[[:space:]]*//p
      s/^\*\*Status\*\*:[[:space:]]*//p
      s/^\*\*상태\*\*:[[:space:]]*//p
      s/^Status:[[:space:]]*//p
      s/^상태:[[:space:]]*//p
    ' | head -1)"
    if [[ -n "$raw" ]]; then
      source="legacy-line"
    fi
  fi

  printf '%s\t%s\n' "$source" "$raw"
}

# ── Count unchecked checkboxes (informational) ──────────────────────
count_unchecked() {
  grep -c '^\s*- \[ \]' "$1" 2>/dev/null || true
}

# ── Main scan ───────────────────────────────────────────────────────
EXIT_CODE=0
COUNT_PLANNING=0
COUNT_UNKNOWN=0
COUNT_NON_CANONICAL=0
declare -a ROWS=()

scan_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  local rel result source raw class unchecked
  rel="${file#$ROOT/}"
  result="$(extract_status "$file")"
  source="$(printf '%s' "$result" | cut -f1)"
  raw="$(printf '%s' "$result" | cut -f2)"
  class="$(normalize_status "$raw")"
  unchecked="$(count_unchecked "$file")"

  ROWS+=("$(printf '%s\t%s\t%s\t%s\t%s' "$class" "$source" "$raw" "$unchecked" "$rel")")

  case "$class" in
    planning|active|blocked)
      (( COUNT_PLANNING++ )) || true
      ;;
    unknown)
      (( COUNT_UNKNOWN++ )) || true
      ;;
    non_canonical)
      (( COUNT_NON_CANONICAL++ )) || true
      ;;
  esac
}

if [[ ! -d "$FIN_DIR" ]]; then
  echo "ERROR: $FIN_DIR not found" >&2
  exit 1
fi

# File source: prefer the explicit allowlist in devlog/structure/status-scope.json
# (current Issue #68/69 shape: { writable: [...] }) if available, else fall back to find.
SCOPE_FILE="devlog/structure/status-scope.json"
USED_SCOPE=false
if [[ -f "$SCOPE_FILE" ]]; then
  while IFS= read -r -d '' file; do
    USED_SCOPE=true
    scan_file "$file"
  done < <(node --eval "
    const fs = require('fs');
    const raw = fs.readFileSync(process.argv[2], 'utf8');
    const data = JSON.parse(raw);
    const excluded = /(?:\\/)(front_repo|reference|references|imported|rag)(?:\\/)/;
    const entries = Array.isArray(data)
      ? data.map((item) => typeof item === 'string' ? item : item && item.path).filter(Boolean)
      : Array.isArray(data.writable)
        ? data.writable
        : Array.isArray(data.paths)
          ? data.paths
          : [];
    for (const rel of entries) {
      const normalized = rel.startsWith('devlog/') ? rel : 'devlog/' + rel.replace(/^\\.\\//, '');
      if (!normalized.includes('/_fin/')) continue;
      if (excluded.test(normalized)) continue;
      process.stdout.write(process.argv[1] + '/' + normalized + '\\0');
    }
  " "$ROOT" "$SCOPE_FILE")
fi

if ! $USED_SCOPE; then
  # Fallback: scan all markdown files under _fin/ while skipping archived reference bundles.
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    scan_file "$file"
  done < <(find "$FIN_DIR" -type f -name '*.md' ! -name '_status_audit.md' \
    ! -path '*/reference/*' ! -path '*/references/*' ! -path '*/imported/*' \
    ! -path '*/front_repo/*' ! -path '*/rag/*' | LC_ALL=C sort)
fi

# ── Write report ────────────────────────────────────────────────────
{
  printf '# Status Audit Report\n\n'
  printf '| class | source | raw_status | unchecked | file |\n'
  printf '|---|---|---|---|---|\n'
  for row in "${ROWS[@]}"; do
    c="$(printf '%s' "$row" | cut -d$'\t' -f1)"
    s="$(printf '%s' "$row" | cut -d$'\t' -f2)"
    r="$(printf '%s' "$row" | cut -d$'\t' -f3)"
    u="$(printf '%s' "$row" | cut -d$'\t' -f4)"
    f="$(printf '%s' "$row" | cut -d$'\t' -f5)"
    printf '| %s | %s | %s | %s | %s |\n' "$c" "$s" "$r" "$u" "$f"
  done
  printf '\n---\n'
  printf 'planning/active/blocked: %d | unknown: %d | non_canonical: %d\n' \
    "$COUNT_PLANNING" "$COUNT_UNKNOWN" "$COUNT_NON_CANONICAL"
} > "$REPORT_FILE"

cat "$REPORT_FILE"

# ── --move-planning (only planning/active/blocked) ──────────────────
if $MOVE_PLANNING; then
  for row in "${ROWS[@]}"; do
    c="$(printf '%s' "$row" | cut -d$'\t' -f1)"
    f="$(printf '%s' "$row" | cut -d$'\t' -f5)"
    case "$c" in
      planning|active|blocked)
        rel_subpath="${f#${FIN_DIR}/}"
        dest="$PLAN_DIR/$rel_subpath"
        echo "MOVE $f -> $dest"
        mkdir -p "$(dirname "$dest")"
        mv "$ROOT/$f" "$dest"
        ;;
    esac
  done
fi

# ── Exit code logic ────────────────────────────────────────────────
if (( COUNT_PLANNING > 0 )); then
  EXIT_CODE=2
fi

if $STRICT && (( COUNT_UNKNOWN + COUNT_NON_CANONICAL > 0 )) && (( EXIT_CODE < 3 )); then
  EXIT_CODE=3
fi

exit "$EXIT_CODE"
