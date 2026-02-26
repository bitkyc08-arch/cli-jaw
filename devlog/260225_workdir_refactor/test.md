# Multi-Instance Refactor — Manual Test Checklist

> **Owner**: Jaw (본인 직접 실행)
> **When**: 각 Phase 구현 완료 후, 머지 전
> **Prerequisite**: `npm run build` 성공 + `npm test` 기존 252개 통과

---

## Phase 1: workingDir Default → JAW_HOME

### P1-M1: 빌드 + 기존 테스트 통과
```bash
npm run build && npm test
# ✅ Expected: 252+ tests pass, 0 fail
```

### P1-M2: AGENTS.md ~/.cli-jaw 기준 동작
```bash
# 1. ~/AGENTS.md 임시 이동
mv ~/AGENTS.md ~/AGENTS.md.bak

# 2. ~/.cli-jaw/AGENTS.md 존재 확인
ls -la ~/.cli-jaw/AGENTS.md

# 3. CLI에서 ~/.cli-jaw의 AGENTS.md 인식하는지 확인
cd ~/.cli-jaw && claude --print "your name?"
# ✅ Expected: "Jaw Agent" 응답

# 4. 복원
mv ~/AGENTS.md.bak ~/AGENTS.md
```

### P1-M3: jaw doctor 정상 동작
```bash
jaw doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: detail에 ~/.cli-jaw 경로 표시, status "ok"
```

---

## Phase 2: JAW_HOME Dynamic

### P2-M1: 기본 동작 변화 없음
```bash
jaw doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: ~/.cli-jaw 그대로
```

### P2-M2: --home 플래그 동작
```bash
# 준비
mkdir -p /tmp/test-jaw-p2

# 테스트
jaw --home /tmp/test-jaw-p2 doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: detail = "/tmp/test-jaw-p2"

# 정리
rm -rf /tmp/test-jaw-p2
```

### P2-M3: --home= 등호 구문
```bash
mkdir -p /tmp/test-jaw-eq
jaw --home=/tmp/test-jaw-eq doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: detail = "/tmp/test-jaw-eq"
rm -rf /tmp/test-jaw-eq
```

### P2-M4: 환경변수 CLI_JAW_HOME
```bash
mkdir -p /tmp/test-jaw-env
CLI_JAW_HOME=/tmp/test-jaw-env jaw doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: detail = "/tmp/test-jaw-env"
rm -rf /tmp/test-jaw-env
```

### P2-M5: 틸드 확장
```bash
jaw --home ~/test-jaw-tilde doctor --json | jq '.checks[] | select(.name == "Home directory")'
# ✅ Expected: detail = "/Users/junny/test-jaw-tilde" (풀 패스)
rm -rf ~/test-jaw-tilde
```

### P2-M6: 프롬프트 경로 확인
```bash
# 커스텀 홈 상태에서 프롬프트에 올바른 경로가 나오는지
mkdir -p /tmp/test-jaw-prompt
jaw --home /tmp/test-jaw-prompt doctor --json > /dev/null 2>&1
# jaw serve 시작 후 프롬프트 내 경로가 /tmp/test-jaw-prompt인지 확인
# (builder.ts 하드코딩 ~/.cli-jaw 가 JAW_HOME으로 대체되었는지)
rm -rf /tmp/test-jaw-prompt
```

### P2-M7: 두 인스턴스 동시 실행
```bash
# Terminal 1
jaw serve &
PID1=$!

# Terminal 2
mkdir -p ~/.jaw-work
jaw serve --home ~/.jaw-work --port 3458 &
PID2=$!

# 둘 다 응답하는지
sleep 3
curl -s localhost:3457/api/cli-status | jq .status
# ✅ Expected: "ok"
curl -s localhost:3458/api/cli-status | jq .status
# ✅ Expected: "ok"

# 정리
kill $PID1 $PID2
```

---

## Phase 3: jaw clone

### P3-M1: 기본 클론
```bash
jaw clone /tmp/test-clone
# ✅ Expected: 성공 메시지 + 디렉토리 생성

# 구조 확인
ls /tmp/test-clone/
# ✅ Expected: prompts/ skills/ mcp.json heartbeat.json settings.json worklogs/ AGENTS.md

# settings.json의 workingDir 확인
cat /tmp/test-clone/settings.json | jq .workingDir
# ✅ Expected: "/tmp/test-clone"

rm -rf /tmp/test-clone
```

### P3-M2: --from 옵션
```bash
mkdir -p /tmp/source-jaw/prompts /tmp/source-jaw/skills
echo '{"workingDir":"/tmp/source-jaw"}' > /tmp/source-jaw/settings.json

jaw clone /tmp/test-clone-from --from /tmp/source-jaw
# ✅ Expected: /tmp/source-jaw 기준으로 복제됨

rm -rf /tmp/test-clone-from /tmp/source-jaw
```

### P3-M3: --with-memory 옵션
```bash
jaw clone /tmp/test-clone-mem --with-memory
# ✅ Expected: memory/MEMORY.md 복사됨

ls /tmp/test-clone-mem/memory/MEMORY.md
# ✅ Expected: 파일 존재

rm -rf /tmp/test-clone-mem
```

### P3-M4: AGENTS.md 재생성 확인
```bash
jaw clone /tmp/test-clone-regen
cat /tmp/test-clone-regen/AGENTS.md | head -5
# ✅ Expected: 유효한 AGENTS.md 내용 (regenerateB 결과)

rm -rf /tmp/test-clone-regen
```

### P3-M5: 이미 존재하는 타겟 에러
```bash
mkdir -p /tmp/test-clone-exist
jaw clone /tmp/test-clone-exist
# ✅ Expected: 에러 메시지 (이미 존재하는 디렉토리)

rm -rf /tmp/test-clone-exist
```

---

## Phase 4: Port Separation + launchd

### P4-M1: 기본 launchd 설치
```bash
jaw launchd
# ✅ Expected: com.cli-jaw.default plist 생성 + 시작
jaw launchd status
# ✅ Expected: PID 표시
jaw launchd unset
# ✅ Expected: 제거됨
```

### P4-M2: 멀티 인스턴스 launchd
```bash
# 기본 인스턴스
jaw launchd
# ✅ Expected: com.cli-jaw.default

# 작업 인스턴스 (Phase 2 --home 필요)
mkdir -p ~/.jaw-work
jaw --home ~/.jaw-work launchd --port 3458
# ✅ Expected: com.cli-jaw.jaw-work-XXXXXXXX (해시 포함)

# 둘 다 동작하는지
launchctl list | grep com.cli-jaw
# ✅ Expected: 2개 항목

curl -s localhost:3457/api/cli-status | jq .status
curl -s localhost:3458/api/cli-status | jq .status
# ✅ Expected: 둘 다 "ok"

# 정리
jaw launchd unset
jaw --home ~/.jaw-work launchd unset
```

### P4-M3: browser/memory 포트 연동
```bash
# 커스텀 포트에서 browser/memory 명령이 올바른 서버로 붙는지
jaw serve --home ~/.jaw-work --port 3458 &
PID=$!
sleep 3

# memory 명령이 3458 서버와 통신하는지
PORT=3458 jaw memory search "test"
# ✅ Expected: 에러 없이 응답 (결과 없어도 OK)

kill $PID
```

### P4-M4: 공백 포함 경로
```bash
mkdir -p "/tmp/test jaw space"
jaw --home "/tmp/test jaw space" launchd --port 3460
# ✅ Expected: mkdir, plist 생성 에러 없음

jaw --home "/tmp/test jaw space" launchd status
jaw --home "/tmp/test jaw space" launchd unset
rm -rf "/tmp/test jaw space"
```

---

## End-to-End: 전체 시나리오

### E2E-1: 풀 워크플로우
```bash
# 1. 클론으로 새 인스턴스 생성
jaw clone ~/.jaw-project-x

# 2. 새 인스턴스로 서버 시작
jaw serve --home ~/.jaw-project-x --port 3460 &
PID=$!
sleep 3

# 3. 새 인스턴스 상태 확인
curl -s localhost:3460/api/cli-status | jq .
# ✅ Expected: status "ok"

# 4. 새 인스턴스에서 doctor
jaw --home ~/.jaw-project-x doctor --json | jq '.checks[] | .name, .status'
# ✅ Expected: 모든 항목 ok

# 5. 정리
kill $PID
rm -rf ~/.jaw-project-x
```

### E2E-2: 기존 환경 무손상 확인
```bash
# 모든 Phase 적용 후, 기존 ~/.cli-jaw 동작이 완전히 동일한지
jaw doctor --json | jq '.checks | length'
# ✅ Expected: 기존과 동일한 체크 수

jaw serve &
PID=$!
sleep 3
curl -s localhost:3457/api/cli-status
# ✅ Expected: 정상 응답
kill $PID

npm test
# ✅ Expected: 252+ pass, 0 fail
```

---

## 결과 기록 양식

| Test ID | Phase | 결과 | 비고 |
|---------|-------|------|------|
| P1-M1   | 1     |      |      |
| P1-M2   | 1     |      |      |
| P1-M3   | 1     |      |      |
| P2-M1   | 2     |      |      |
| P2-M2   | 2     |      |      |
| P2-M3   | 2     |      |      |
| P2-M4   | 2     |      |      |
| P2-M5   | 2     |      |      |
| P2-M6   | 2     |      |      |
| P2-M7   | 2     |      |      |
| P3-M1   | 3     |      |      |
| P3-M2   | 3     |      |      |
| P3-M3   | 3     |      |      |
| P3-M4   | 3     |      |      |
| P3-M5   | 3     |      |      |
| P4-M1   | 4     |      |      |
| P4-M2   | 4     |      |      |
| P4-M3   | 4     |      |      |
| P4-M4   | 4     |      |      |
| E2E-1   | ALL   |      |      |
| E2E-2   | ALL   |      |      |
