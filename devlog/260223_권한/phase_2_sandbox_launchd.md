# Phase 2: 샌드박스 해제 + LaunchD GUI Spawn

## 문제

### 2.1 Codex 샌드박스
- `--full-auto` = `workspace-write` 모드 → `ps`, `pkill`, 시스템 명령 차단
- 필요: `--dangerously-bypass-approvals-and-sandbox` (sandbox 완전 해제)

### 2.2 osascript GUI 접근
- `child_process.spawn()`으로 만든 프로세스는 GUI WindowServer에 연결 안 됨
- `osascript`로 앱 제어(브라우저 종료 등) 불가: "Connection invalid"
- `launchd agent`는 사용자의 GUI 세션에서 실행 → WindowServer 접근 가능

> 출처: [Apple Developer - launchd](https://developer.apple.com/documentation/servicemanagement)  
> Agent = per-user login session (GUI 접근 가능)  
> Daemon = system-wide background (GUI 접근 불가)

---

## 2.1 구현: Codex 샌드박스 해제

### 현재 (buildArgs)

```javascript
case 'codex':
    return ['exec',
        '--full-auto', '--skip-git-repo-check', '--json'];
```

### 변경

```javascript
case 'codex':
    return ['exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check', '--json'];
```

### 파일 변경

| 파일                                 | 변경                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `server.js` buildArgs L535-539       | `--full-auto` → `--dangerously-bypass-approvals-and-sandbox` |
| `server.js` buildResumeArgs L565-568 | 동일                                                         |

---

## 2.2 설계: LaunchD GUI Spawn

### 방향

현재:
```
cli-claw serve (Node.js)
  └─ spawn('codex', args)  ← 비-GUI 자식 프로세스
       └─ osascript ❌ Connection invalid
```

목표:
```
cli-claw serve (Node.js)
  └─ launchctl submit (또는 launchd agent plist)
       └─ codex (GUI 세션에서 실행)
            └─ osascript ✅ WindowServer 접근 가능
```

### 방법 A: `launchctl submit` (임시 작업)

```javascript
// server.js spawnAgent()
const { execSync } = require('child_process');
const uid = process.getuid();

// GUI 세션에서 명령 실행
execSync(`launchctl asuser ${uid} /usr/bin/env codex exec --dangerously-bypass-approvals-and-sandbox --json "${prompt}"`);
```

**장점**: 간단, 기존 코드 최소 변경  
**단점**: stdout/stderr 스트리밍이 어려움 (비동기 파이프 필요)

### 방법 B: launchd plist 동적 생성

```xml
<!-- ~/Library/LaunchAgents/com.claw.agent.JOBID.plist -->
<plist>
  <dict>
    <key>Label</key><string>com.claw.agent.12345</string>
    <key>ProgramArguments</key>
    <array>
      <string>codex</string>
      <string>exec</string>
      <string>--dangerously-bypass-approvals-and-sandbox</string>
    </array>
    <key>StandardOutPath</key><string>/tmp/claw-agent-12345.stdout</string>
    <key>StandardErrorPath</key><string>/tmp/claw-agent-12345.stderr</string>
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

```javascript
// 1. plist 생성
fs.writeFileSync(plistPath, xml);
// 2. launchctl load
execSync(`launchctl load ${plistPath}`);
// 3. tail stdout 파일로 스트리밍
const tail = spawn('tail', ['-f', stdoutPath]);
// 4. 완료 후 unload + cleanup
execSync(`launchctl unload ${plistPath}`);
```

**장점**: GUI 세션 확실 보장, stdout 스트리밍 가능  
**단점**: plist 관리 복잡, 임시 파일 정리 필요

### 방법 C: 하이브리드 (추천)

평상시는 기존 `spawn()` 사용, **osascript 필요 시만** `launchctl asuser` 래핑:

```javascript
function spawnInGUI(command, args) {
    const uid = process.getuid();
    // launchctl asuser로 GUI 세션에서 실행
    return spawn('launchctl', ['asuser', uid.toString(), command, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
```

settings에 `guiMode: true` 옵션 추가, 기본값 false:
- false: 기존 spawn (가볍고 빠름)
- true: launchctl asuser 래핑 (GUI 앱 제어 가능)

### 파일 변경

| 파일                   | 변경                                 |
| ---------------------- | ------------------------------------ |
| `server.js` spawnAgent | guiMode 분기 + launchctl asuser 래핑 |
| settings.json          | `guiMode: false` 기본값              |
| bin/commands/doctor.js | GUI 세션 접근 테스트                 |

---

## 체크리스트

### Phase 2.1 (빠른 수정)
- [ ] buildArgs: `--full-auto` → `--dangerously-bypass-approvals-and-sandbox`
- [ ] buildResumeArgs: 동일
- [ ] 테스트: ps/pkill 동작 확인

### Phase 2.2 (설계 검증 필요)
- [ ] 방법 C(하이브리드) 프로토타입
- [ ] launchctl asuser stdin/stdout 파이프 테스트
- [ ] guiMode 설정 + doctor 체크
- [ ] osascript 브라우저 종료 테스트
