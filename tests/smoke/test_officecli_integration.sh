#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OfficeCLI Integration Smoke Tests for cli-jaw
#  Run from cli-jaw root: bash tests/smoke/test_officecli_integration.sh
# ═══════════════════════════════════════════════════════════════
set -uo pipefail

PASS=0; FAIL=0; TOTAL=8
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKDIR="${SCRIPT_DIR}/.work/officecli"

if [ -n "${OFFICECLI_BIN:-}" ]; then
  OFFICECLI="${OFFICECLI_BIN}"
elif command -v officecli >/dev/null 2>&1; then
  OFFICECLI="officecli"
elif [ -x "${REPO_ROOT}/officecli/build-local/officecli" ]; then
  OFFICECLI="${REPO_ROOT}/officecli/build-local/officecli"
else
  OFFICECLI="officecli"
fi

mkdir -p "$WORKDIR"
rm -f "$WORKDIR"/smoke_test.docx "$WORKDIR"/smoke_test.xlsx "$WORKDIR"/smoke_test.pptx

pass() { ((PASS++)); echo "  ✅ PASS: $1"; }
fail_test() { ((FAIL++)); echo "  ❌ FAIL: $1 — $2"; }
contains_text() { [[ "$1" == *"$2"* ]]; }

echo "═══════════════════════════════════════════"
echo " OfficeCLI Integration Smoke Tests"
echo "═══════════════════════════════════════════"
echo ""

# ─── Test 1: Binary availability ───
echo "1/8  Binary availability"
if $OFFICECLI --version > /dev/null 2>&1; then
  VER=$($OFFICECLI --version 2>/dev/null)
  pass "officecli v${VER} found"
else
  fail_test "officecli binary not found" "Install: scripts/install-officecli.sh"
fi

# ─── Test 2: DOCX create + write + read ───
echo "2/8  DOCX create → write → read"
if $OFFICECLI create "$WORKDIR/smoke_test.docx" > /dev/null 2>&1 && \
   $OFFICECLI add "$WORKDIR/smoke_test.docx" /body --type paragraph --prop text="Hello from cli-jaw" > /dev/null 2>&1; then
  DOCX_TEXT="$($OFFICECLI view "$WORKDIR/smoke_test.docx" text 2>/dev/null)" || DOCX_TEXT=""
  if contains_text "$DOCX_TEXT" "Hello from cli-jaw"; then
    pass "DOCX create/write/read"
  else
    fail_test "DOCX create/write/read" "Write succeeded but text was not readable"
  fi
else
  fail_test "DOCX create/write/read" "Verify officecli docx commands"
fi

# ─── Test 3: XLSX create + write + read ───
echo "3/8  XLSX create → write → read"
if $OFFICECLI create "$WORKDIR/smoke_test.xlsx" > /dev/null 2>&1 && \
   $OFFICECLI set "$WORKDIR/smoke_test.xlsx" /Sheet1/A1 --prop value=TestData > /dev/null 2>&1; then
  XLSX_TEXT="$($OFFICECLI view "$WORKDIR/smoke_test.xlsx" text 2>/dev/null)" || XLSX_TEXT=""
  if contains_text "$XLSX_TEXT" "TestData"; then
    pass "XLSX create/write/read"
  else
    fail_test "XLSX create/write/read" "Write succeeded but cell value was not readable"
  fi
else
  fail_test "XLSX create/write/read" "Verify officecli xlsx commands"
fi

# ─── Test 4: PPTX create + write + read ───
echo "4/8  PPTX create → add slide → read"
if $OFFICECLI create "$WORKDIR/smoke_test.pptx" > /dev/null 2>&1 && \
   $OFFICECLI add "$WORKDIR/smoke_test.pptx" / --type slide --prop title="Smoke Test Slide" > /dev/null 2>&1; then
  PPTX_TEXT="$($OFFICECLI view "$WORKDIR/smoke_test.pptx" outline 2>/dev/null)" || PPTX_TEXT=""
  if contains_text "$PPTX_TEXT" "Smoke Test Slide"; then
    pass "PPTX create/add/read"
  else
    fail_test "PPTX create/add/read" "Slide was created but title was not readable"
  fi
else
  fail_test "PPTX create/add/read" "Verify officecli pptx commands"
fi

# ─── Test 5: Validation ───
echo "5/8  Validation"
VALID_OK=true
for f in smoke_test.docx smoke_test.xlsx smoke_test.pptx; do
  if ! $OFFICECLI validate "$WORKDIR/$f" > /dev/null 2>&1; then
    VALID_OK=false
    break
  fi
done
if $VALID_OK; then
  pass "All three formats pass validation"
else
  fail_test "Validation" "One or more formats failed validation"
fi

# ─── Test 6: CJK text roundtrip ───
echo "6/8  CJK text roundtrip"
if $OFFICECLI add "$WORKDIR/smoke_test.docx" /body --type paragraph --prop text="한글 테스트 日本語 中文" > /dev/null 2>&1; then
  DOCX_TEXT="$($OFFICECLI view "$WORKDIR/smoke_test.docx" text 2>/dev/null)" || DOCX_TEXT=""
  if contains_text "$DOCX_TEXT" "한글 테스트"; then
    pass "CJK text preserved in roundtrip"
  else
    fail_test "CJK text roundtrip" "Korean/CJK text lost during write→read"
  fi
else
  fail_test "CJK text roundtrip" "Failed to append CJK paragraph"
fi

# ─── Test 7: Batch operations ───
echo "7/8  Batch operations"
BATCH_JSON='[{"command":"set","path":"/Sheet1/A2","props":{"value":"BatchValue"}},{"command":"set","path":"/Sheet1/B1","props":{"value":"42"}}]'
if $OFFICECLI batch "$WORKDIR/smoke_test.xlsx" --json <<<"$BATCH_JSON" > /dev/null 2>&1; then
  XLSX_TEXT="$($OFFICECLI view "$WORKDIR/smoke_test.xlsx" text 2>/dev/null)" || XLSX_TEXT=""
  if contains_text "$XLSX_TEXT" "BatchValue"; then
    pass "Batch operations executed"
  else
    fail_test "Batch operations" "Batch command ran but expected cell value was not found"
  fi
else
  fail_test "Batch operations" "Batch JSON command failed"
fi

# ─── Test 8: JSON output ───
echo "8/8  JSON output"
DOC_JSON="$($OFFICECLI get "$WORKDIR/smoke_test.docx" / --json 2>/dev/null)" || DOC_JSON=""
if [ -n "$DOC_JSON" ] && python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('success') is True" <<<"$DOC_JSON" 2>/dev/null; then
  pass "JSON output is valid and successful"
else
  fail_test "JSON output" "get --json did not return valid JSON with success=true"
fi

# ─── Cleanup work files ───
rm -f "$WORKDIR"/smoke_test.{docx,xlsx,pptx}

# ─── Summary ───
echo ""
echo "═══════════════════════════════════════════"
echo " Results: ${PASS}/${TOTAL} passed, ${FAIL}/${TOTAL} failed"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
