#!/bin/bash
# spike-tcc-attribution.sh
# 목적: macOS TCC가 `Jaw.app` bundle identity로 Automation 권한을 귀속시키는지 실측 검증.
# 이 스크립트는 31/32 계획의 핵심 가정(shell-shim launcher → com.cli-jaw.agent 책임)을
# 실제 하드웨어에서 확인한다. 계획을 B로 진입시키기 전 반드시 1회 이상 PASS해야 한다.
#
# 사용:
#   bash scripts/darwin/spike-tcc-attribution.sh                # dry-run check
#   bash scripts/darwin/spike-tcc-attribution.sh --build        # 임시 Jaw.app 번들 생성 후 검증
#   bash scripts/darwin/spike-tcc-attribution.sh --cleanup      # 생성된 임시 번들 제거
#
# 출력 원칙:
#   - 각 단계마다 PASS/FAIL을 찍고 실패 시 즉시 exit (fail-fast 규칙)
#   - 마지막에 `RESULT=...` 한 줄을 찍어 호출자가 grep하기 쉽게 한다

set -euo pipefail

# ── Colors ──
CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; echo "RESULT=FAIL"; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then fail "macOS 전용"; fi

MODE="${1:-check}"
SPIKE_APP_DIR="/Applications/JawSpike.app"
SPIKE_BUNDLE_ID="com.cli-jaw.spike"

print_header() {
  echo ""
  echo -e "${CYAN}${BOLD}🔬 TCC Attribution Spike${NC}"
  echo -e "${DIM}   검증: shell-shim launcher가 $SPIKE_BUNDLE_ID 로 귀속되는가${NC}"
  echo ""
}

step_check_prereqs() {
  info "1/6 전제 조건 점검"
  command -v osascript >/dev/null || fail "osascript 없음"
  [[ -d "/Applications/Google Chrome.app" ]] || fail "Google Chrome 미설치 — 설치 후 재시도"
  command -v /usr/libexec/PlistBuddy >/dev/null || fail "PlistBuddy 없음"
  ok "prereq OK"
}

step_probe_path_sources() {
  info "2/6 CLI binary PATH 감지 (bun / npm-global / nvm)"
  BUN_BIN_DIR=""
  NPM_BIN_DIR=""
  NVM_BIN_DIR=""
  if command -v bun >/dev/null; then BUN_BIN_DIR="$(dirname "$(command -v bun)")"; fi
  if command -v npm >/dev/null; then NPM_BIN_DIR="$(npm config get prefix 2>/dev/null)/bin"; fi
  if [[ -n "${NVM_DIR:-}" && -d "$NVM_DIR" ]]; then
    NVM_BIN_DIR="$(ls -dt "$NVM_DIR"/versions/node/*/bin 2>/dev/null | head -1 || true)"
  fi

  echo "   BUN:  ${BUN_BIN_DIR:-∅}"
  echo "   NPM:  ${NPM_BIN_DIR:-∅}"
  echo "   NVM:  ${NVM_BIN_DIR:-∅}"

  # cli-jaw가 실제로 어디서 발견되는지
  JAW_BIN="$(command -v cli-jaw || true)"
  [[ -n "$JAW_BIN" ]] || fail "cli-jaw가 현재 PATH에 없음 — npm i -g cli-jaw 먼저"
  JAW_BIN_DIR="$(dirname "$JAW_BIN")"
  echo "   cli-jaw: $JAW_BIN"

  # PATH 머지 (중복 제거, 존재하는 것만)
  MERGED_PATH=""
  for d in "$JAW_BIN_DIR" "$BUN_BIN_DIR" "$NPM_BIN_DIR" "$NVM_BIN_DIR" \
           "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin"; do
    [[ -z "$d" || ! -d "$d" ]] && continue
    case ":$MERGED_PATH:" in *":$d:"*) ;; *) MERGED_PATH="${MERGED_PATH:+$MERGED_PATH:}$d";; esac
  done
  echo "   MERGED_PATH=$MERGED_PATH"
  ok "PATH sources detected"
}

build_spike_app() {
  info "3/6 임시 Jaw.app (JawSpike.app) 생성"
  if [[ -d "$SPIKE_APP_DIR" ]]; then
    warn "기존 $SPIKE_APP_DIR 감지 — 삭제 후 재생성"
    rm -rf "$SPIKE_APP_DIR"
  fi

  mkdir -p "$SPIKE_APP_DIR/Contents/MacOS"
  mkdir -p "$SPIKE_APP_DIR/Contents/Resources"

  cat > "$SPIKE_APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$SPIKE_BUNDLE_ID</string>
  <key>CFBundleName</key><string>JawSpike</string>
  <key>CFBundleDisplayName</key><string>Jaw Spike</string>
  <key>CFBundleExecutable</key><string>jaw-spike-launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Jaw Spike — TCC attribution test</string>
</dict>
</plist>
PLIST

  cat > "$SPIKE_APP_DIR/Contents/MacOS/jaw-spike-launcher" <<LAUNCHER
#!/bin/bash
# PATH pin: CLI discovery from bun / npm / nvm
export PATH="$MERGED_PATH"
# 실제 책임 주체가 누구인지 보기 위해 osascript를 직접 실행
exec /usr/bin/osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'
LAUNCHER
  chmod +x "$SPIKE_APP_DIR/Contents/MacOS/jaw-spike-launcher"

  # Launch Services 등록
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f -R "$SPIKE_APP_DIR" 2>/dev/null || warn "lsregister 실패 (무시 가능)"
  xattr -dr com.apple.quarantine "$SPIKE_APP_DIR" 2>/dev/null || true

  ok "JawSpike.app 생성됨: $SPIKE_APP_DIR"
}

probe_attribution() {
  info "4/6 첫 실행 (TCC 프롬프트 예상)"
  echo ""
  echo -e "${YELLOW}   프롬프트가 뜨면 '허용'을 누르세요. 이름은 '${BOLD}Jaw Spike${NC}${YELLOW}'로 보여야 합니다.${NC}"
  echo -e "${YELLOW}   만약 'Terminal' 또는 'osascript'로 뜨면 귀속 실패입니다.${NC}"
  echo ""
  read -r -p "   계속하려면 Enter..." _

  # open -a는 LaunchServices를 통해 번들을 실행 → responsibility가 번들로 귀속됨
  if ! open -W -a "$SPIKE_APP_DIR" 2>&1; then
    warn "open -W가 non-zero — 권한 거부 또는 Chrome 비실행 상태일 수 있음"
  fi

  info "5/6 권한 DB에서 귀속 주체 조회"
  DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  if [[ ! -f "$DB" ]]; then warn "유저 TCC.db 없음 (조회 스킵)"; return; fi

  # kTCCServiceAppleEvents 레코드에서 client 필드 확인 (read-only)
  ATTR=$(sqlite3 "$DB" \
    "SELECT client FROM access WHERE service='kTCCServiceAppleEvents' AND client LIKE '%cli-jaw%' OR client LIKE '%jaw-spike%';" \
    2>/dev/null || true)

  if [[ -z "$ATTR" ]]; then
    warn "TCC.db에 $SPIKE_BUNDLE_ID 관련 레코드 없음 — 아직 허용이 기록되지 않았거나 귀속 실패"
  else
    echo "   TCC client 엔트리:"
    echo "$ATTR" | sed 's/^/     /'
  fi
}

verdict() {
  info "6/6 결론 출력"
  DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  PASS=false
  if [[ -f "$DB" ]]; then
    if sqlite3 "$DB" "SELECT client FROM access WHERE service='kTCCServiceAppleEvents' AND client='$SPIKE_BUNDLE_ID';" 2>/dev/null | grep -q "$SPIKE_BUNDLE_ID"; then
      PASS=true
    fi
  fi

  if $PASS; then
    ok "RESULT=PASS — shell-shim launcher가 $SPIKE_BUNDLE_ID 로 귀속됨"
    echo "RESULT=PASS"
    echo "   → 31/32 계획의 shell-shim 전략 진행 가능"
  else
    warn "RESULT=INCONCLUSIVE_OR_FAIL"
    echo "RESULT=INCONCLUSIVE"
    echo ""
    echo "   가능한 원인과 대처:"
    echo "   1) 프롬프트에서 거부/무시함 → 재실행"
    echo "   2) Terminal/osascript로 귀속됨 → shell-shim 전략 불가. 대안:"
    echo "      a. Swift/C 네이티브 mini-launcher (앱 번들 executable이 실제 네이티브 바이너리)"
    echo "      b. launchd ProgramArguments에 Jaw.app 자체를 지정하는 대신"
    echo "         /Applications/Jaw.app/Contents/MacOS/jaw-launcher 를 pid 1 자식으로 두기"
    echo "   3) TCC.db 권한 없음 → Full Disk Access가 필요할 수 있음"
  fi
}

build_native_spike() {
  info "3/6 [V2 native] clang 확인 + Obj-C launcher 컴파일"
  if ! command -v /usr/bin/clang >/dev/null; then
    fail "clang 없음 — Xcode Command Line Tools 설치: xcode-select --install"
  fi
  ok "clang: $(/usr/bin/clang --version | head -1)"

  if [[ -d "$SPIKE_APP_DIR" ]]; then
    warn "기존 $SPIKE_APP_DIR 제거"
    rm -rf "$SPIKE_APP_DIR"
  fi
  mkdir -p "$SPIKE_APP_DIR/Contents/MacOS"
  mkdir -p "$SPIKE_APP_DIR/Contents/Resources"

  cat > "$SPIKE_APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$SPIKE_BUNDLE_ID</string>
  <key>CFBundleName</key><string>JawSpike</string>
  <key>CFBundleDisplayName</key><string>Jaw Spike Native</string>
  <key>CFBundleExecutable</key><string>jaw-spike-launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.2</string>
  <key>CFBundleVersion</key><string>0.0.2</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Jaw Spike — native launcher TCC test</string>
</dict>
</plist>
PLIST

  # Objective-C source: Mach-O that fires an AppleEvent (TCC 진짜 트리거)
  local SRC="$(mktemp -t jaw-spike-XXXXXX).m"
  cat > "$SRC" <<'OBJC'
#import <Foundation/Foundation.h>
int main(void) {
    @autoreleasepool {
        NSAppleScript *s = [[NSAppleScript alloc] initWithSource:
            @"tell application \"Google Chrome\" to get URL of active tab of front window"];
        NSDictionary *err = nil;
        NSAppleEventDescriptor *r = [s executeAndReturnError:&err];
        if (err) {
            fprintf(stderr, "ERR: %s\n", [[err description] UTF8String]);
            return 1;
        }
        NSString *v = [r stringValue];
        printf("URL=%s\n", v ? [v UTF8String] : "(null)");
        return 0;
    }
}
OBJC

  local OUT="$SPIKE_APP_DIR/Contents/MacOS/jaw-spike-launcher"
  if ! /usr/bin/clang -framework Foundation -O2 -o "$OUT" "$SRC"; then
    rm -f "$SRC"
    fail "clang compile 실패"
  fi
  rm -f "$SRC"
  chmod +x "$OUT"

  # ad-hoc codesign so TCC accepts the bundle identity stably
  /usr/bin/codesign --force --sign - "$SPIKE_APP_DIR" 2>/dev/null || warn "codesign 실패 (무시 가능)"

  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f -R "$SPIKE_APP_DIR" 2>/dev/null || warn "lsregister 실패"
  xattr -dr com.apple.quarantine "$SPIKE_APP_DIR" 2>/dev/null || true

  ok "Native JawSpike.app 컴파일 완료: $SPIKE_APP_DIR"
  file "$OUT" | sed 's/^/   /'
}

verdict_native() {
  info "6/6 V2 결론"
  DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  if [[ ! -f "$DB" ]]; then
    warn "TCC.db 접근 불가 — Terminal/iTerm에 Full Disk Access 필요"
    echo "RESULT=INCONCLUSIVE_NO_TCC_ACCESS"
    return
  fi

  local SPIKE_ROW
  SPIKE_ROW=$(sqlite3 "$DB" \
    "SELECT client FROM access WHERE service='kTCCServiceAppleEvents' AND client='$SPIKE_BUNDLE_ID';" \
    2>/dev/null || true)

  if [[ -n "$SPIKE_ROW" ]]; then
    ok "RESULT=PASS — Mach-O launcher가 $SPIKE_BUNDLE_ID 로 귀속됨"
    echo "RESULT=PASS"
    echo "   → 31/32의 native launcher 전략 진행 가능"
    return
  fi

  # 실패 상세: 실제 누구에게 귀속됐는지 힌트
  warn "RESULT=FAIL — $SPIKE_BUNDLE_ID TCC 엔트리 없음"
  echo "RESULT=FAIL"
  echo ""
  echo "   TCC.db의 최근 AppleEvents 허용 client 상위 10개:"
  sqlite3 "$DB" \
    "SELECT client, datetime(last_modified, 'unixepoch', 'localtime') FROM access WHERE service='kTCCServiceAppleEvents' ORDER BY last_modified DESC LIMIT 10;" \
    2>/dev/null | sed 's/^/     /'
  echo ""
  echo "   프롬프트 제목이 무엇으로 떴는지(예: 'Jaw Spike Native' vs 'osascript' vs 'bash')가 핵심 증거입니다."
  echo "   'Jaw Spike Native'였다면 유저가 허용만 안 누른 것 — 재실행하세요."
  echo "   다른 이름이었다면 native launcher도 귀속 실패 → 계획 재협상 필요."
}

cleanup() {
  info "cleanup"
  if [[ -d "$SPIKE_APP_DIR" ]]; then
    rm -rf "$SPIKE_APP_DIR"
    ok "$SPIKE_APP_DIR 제거됨"
  else
    ok "이미 깨끗함"
  fi
}

case "$MODE" in
  --cleanup|cleanup) cleanup; exit 0 ;;
  --build|build)
    print_header
    warn "V1 (shell-shim) 모드는 이미 FAIL 판정 — 참고용으로만 실행하세요."
    step_check_prereqs
    step_probe_path_sources
    build_spike_app
    probe_attribution
    verdict
    ;;
  --build-native|build-native|--v2|v2)
    print_header
    echo -e "${DIM}   V2: Mach-O Objective-C launcher 기반 재검증${NC}"
    echo ""
    step_check_prereqs
    step_probe_path_sources
    build_native_spike
    probe_attribution
    verdict_native
    ;;
  *)
    print_header
    step_check_prereqs
    step_probe_path_sources
    warn "dry-run 모드 — 번들 생성/권한 요청은 스킵"
    echo ""
    echo "다음 단계:"
    echo "   bash $0 --build-native   # V2: clang Mach-O 기반 (권장)"
    echo "   bash $0 --build          # V1: shell-shim (이미 FAIL, 참고용)"
    echo "   bash $0 --cleanup        # spike 번들 제거"
    ;;
esac
