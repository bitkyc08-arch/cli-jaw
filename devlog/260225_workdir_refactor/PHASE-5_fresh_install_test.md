# Phase 5: Fresh Install Acceptance Test (다른 컴퓨터)

**Status**: Plan  
**환경**: macOS (다른 컴퓨터), Node.js 20+  
**전제**: npm 배포 완료 후 실행  

---

## 0. 완전 제거 (클린 상태 확보)

```bash
# 1. npm 글로벌 제거
npm uninstall -g cli-jaw

# 2. 잔여 바이너리 확인
which jaw && echo "⚠️  jaw 아직 남아있음" || echo "✅ jaw 제거됨"
which cli-jaw && echo "⚠️  cli-jaw 아직 남아있음" || echo "✅ cli-jaw 제거됨"

# 3. 데이터 디렉토리 백업 후 제거
[ -d ~/.cli-jaw ] && mv ~/.cli-jaw ~/.cli-jaw.bak.$(date +%s)
[ -d ~/.jaw-work ] && rm -rf ~/.jaw-work

# 4. launchd 잔여 plist 제거
ls ~/Library/LaunchAgents/com.cli-jaw.* 2>/dev/null && \
  launchctl unload ~/Library/LaunchAgents/com.cli-jaw.* 2>/dev/null; \
  rm -f ~/Library/LaunchAgents/com.cli-jaw.*

# 5. 확인
echo "=== Clean State Check ==="
which jaw; which cli-jaw; ls ~/.cli-jaw 2>/dev/null; ls ~/Library/LaunchAgents/com.cli-jaw.* 2>/dev/null
# ✅ Expected: 전부 "not found" / "No such file"
```

---

## 1. 설치

```bash
npm install -g cli-jaw
# ✅ Expected: postinstall 실행 → ~/.cli-jaw 디렉토리 생성

# 설치 확인
which jaw
# ✅ Expected: 경로 출력 (e.g., /usr/local/bin/jaw)

jaw --version 2>/dev/null || jaw doctor --json | jq .version
# ✅ Expected: 0.1.x
```

---

## 2. 기본 동작 (⚡ 시간 없으면 여기까지)

### T-01: doctor
```bash
jaw doctor --json | jq '.checks[] | {name, status}'
# ✅ Expected: 모든 항목 status "ok" (일부 "warn" 허용 — API key 등)
```

### T-02: serve + 웹 UI
```bash
jaw serve &
PID=$!
sleep 3

# API 응답
curl -s localhost:3457/api/cli-status | jq .status
# ✅ Expected: "ok"

# 웹 UI 접근
curl -s -o /dev/null -w "%{http_code}" localhost:3457/
# ✅ Expected: 200

kill $PID
```

### T-03: 기본 설정 값 확인
```bash
cat ~/.cli-jaw/settings.json | jq '{workingDir, permissions}'
# ✅ Expected: workingDir = 홈디렉토리/.cli-jaw 경로, permissions = "auto"
```

---

## 3. Multi-Instance (Phase 1-4 검증)

### T-04: --home 플래그
```bash
mkdir -p /tmp/test-jaw-fresh
jaw --home /tmp/test-jaw-fresh doctor --json | jq '.checks[] | select(.name == "Home directory") | .detail'
# ✅ Expected: "/tmp/test-jaw-fresh"
rm -rf /tmp/test-jaw-fresh
```

### T-05: --home= 등호 구문
```bash
mkdir -p /tmp/test-jaw-eq
jaw --home=/tmp/test-jaw-eq doctor --json | jq '.checks[] | select(.name == "Home directory") | .detail'
# ✅ Expected: "/tmp/test-jaw-eq"
rm -rf /tmp/test-jaw-eq
```

### T-06: CLI_JAW_HOME 환경변수
```bash
mkdir -p /tmp/test-jaw-env
CLI_JAW_HOME=/tmp/test-jaw-env jaw doctor --json | jq '.checks[] | select(.name == "Home directory") | .detail'
# ✅ Expected: "/tmp/test-jaw-env"
rm -rf /tmp/test-jaw-env
```

### T-07: jaw clone
```bash
jaw clone /tmp/test-clone-fresh
# ✅ Expected: 성공 메시지

ls /tmp/test-clone-fresh/settings.json
# ✅ Expected: 파일 존재

cat /tmp/test-clone-fresh/settings.json | jq .workingDir
# ✅ Expected: "/tmp/test-clone-fresh"

rm -rf /tmp/test-clone-fresh
```

### T-08: 두 인스턴스 동시 실행
```bash
# 인스턴스 A (기본)
jaw serve &
PID_A=$!

# 인스턴스 B (커스텀)
jaw clone ~/.jaw-work 2>/dev/null
jaw --home ~/.jaw-work serve --port 3458 &
PID_B=$!

sleep 3

curl -s localhost:3457/api/cli-status | jq .status
# ✅ Expected: "ok"

curl -s localhost:3458/api/cli-status | jq .status
# ✅ Expected: "ok"

kill $PID_A $PID_B
rm -rf ~/.jaw-work
```

---

## 4. launchd (macOS only)

### T-09: 기본 launchd 등록
```bash
jaw launchd
# ✅ Expected: com.cli-jaw.default plist 생성 + 시작

jaw launchd status
# ✅ Expected: instance "default", port 3457, PID 표시

curl -s localhost:3457/api/cli-status | jq .status
# ✅ Expected: "ok"

jaw launchd unset
# ✅ Expected: 해제 완료
```

### T-10: 멀티 인스턴스 launchd
```bash
# 기본
jaw launchd
# ✅ Expected: com.cli-jaw.default

# 작업용
jaw clone ~/.jaw-work 2>/dev/null
jaw --home ~/.jaw-work launchd --port 3458
# ✅ Expected: com.cli-jaw.jaw-work-XXXXXXXX

launchctl list | grep com.cli-jaw
# ✅ Expected: 2개 항목

curl -s localhost:3457/api/cli-status | jq .status
curl -s localhost:3458/api/cli-status | jq .status
# ✅ Expected: 둘 다 "ok"

# 정리
jaw launchd unset
jaw --home ~/.jaw-work launchd unset
rm -rf ~/.jaw-work
```

### T-11: 공백 경로
```bash
mkdir -p "/tmp/test jaw space"
jaw --home "/tmp/test jaw space" launchd --port 3460
# ✅ Expected: 에러 없이 plist 생성

jaw --home "/tmp/test jaw space" launchd status
jaw --home "/tmp/test jaw space" launchd unset
rm -rf "/tmp/test jaw space"
```

---

## 5. 에러 핸들링

### T-12: --home 값 누락
```bash
jaw --home clone 2>&1
# ✅ Expected: 에러 메시지 + exit code != 0
echo $?
# ✅ Expected: 1
```

### T-13: 존재하지 않는 소스로 clone
```bash
jaw clone /tmp/test-bad --from /nonexistent/path 2>&1
# ✅ Expected: 에러 메시지 (source not found)
echo $?
# ✅ Expected: 1
```

### T-14: 이미 존재하는 타겟으로 clone
```bash
mkdir -p /tmp/test-exist
jaw clone /tmp/test-exist 2>&1
# ✅ Expected: 에러 메시지 (이미 존재)
rm -rf /tmp/test-exist
```

### T-15: launchd unknown flag
```bash
jaw launchd --dry-run 2>&1
# ✅ Expected: "Unknown option: --dry-run" + exit 1
echo $?
# ✅ Expected: 1
```

---

## 6. UI 검증 (브라우저)

### T-16: 웹 대시보드
```bash
jaw serve &
PID=$!
sleep 3
open http://localhost:3457
```
- [ ] workingDir 입력란: 빈 값 + placeholder 표시 (하드코딩 `~/` 아님)
- [ ] 권한 토글: "Auto" 배지 고정 (Safe/Auto 버튼 없음)
- [ ] 설정 저장 후 새로고침 → 값 유지

```bash
kill $PID
```

---

## 7. 정리

```bash
# launchd 해제 (등록한 경우)
jaw launchd unset 2>/dev/null
jaw --home ~/.jaw-work launchd unset 2>/dev/null

# 테스트 데이터 정리
rm -rf /tmp/test-jaw-* /tmp/test-clone-* /tmp/test-exist /tmp/test-bad
rm -rf ~/.jaw-work

# cli-jaw 데이터 보존 or 제거
# 보존: 그대로 두기
# 제거: rm -rf ~/.cli-jaw
```

---

## Quick Reference: 시간별 테스트 범위

| 시간 | 범위 | 테스트 ID |
|------|------|-----------|
| **3분** | 설치 + doctor + serve | T-01, T-02, T-03 |
| **10분** | + multi-instance + clone | + T-04, T-07, T-08 |
| **20분** | + launchd + 에러 핸들링 | + T-09, T-12~T-15 |
| **30분** | 전체 (UI 포함) | T-01 ~ T-16 |

---

## 결과 기록

| Test | 결과 | 비고 |
|------|------|------|
| T-01 |  |  |
| T-02 |  |  |
| T-03 |  |  |
| T-04 |  |  |
| T-05 |  |  |
| T-06 |  |  |
| T-07 |  |  |
| T-08 |  |  |
| T-09 |  |  |
| T-10 |  |  |
| T-11 |  |  |
| T-12 |  |  |
| T-13 |  |  |
| T-14 |  |  |
| T-15 |  |  |
| T-16 |  |  |
