# Phase 8.4: catch 정책 + 예외 처리 일관화 설계

> 이 문서는 Phase 8의 P0~P1(조용한 에러 정리) 설계를 다룬다.

---

## 왜 해야 하는가

### 현재 상태

```bash
$ rg -n "catch \{" server.js src lib -g'*.js' | wc -l
63
```

63건의 `catch {}` 중 상당수가 에러를 완전히 무시하여 **운영 관측 불가** 상태.

### 위험한 패턴 (실제 코드)

**1) 프로세스 kill 실패 무시**

```js
// src/agent.js L28-31
try { activeProcess.kill('SIGTERM'); } catch { }
setTimeout(() => {
    try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { }
}, 2000);
```

문제: kill이 실패하면 좀비 프로세스가 남지만 아무 로그도 없음.

**2) subtask JSON 파싱 실패 무시**

```js
// src/orchestrator.js L100-104
try { return JSON.parse(fenced[1]).subtasks || null; } catch { }
// fallback
try { return JSON.parse(raw[1]).subtasks || null; } catch { }
```

문제: JSON이 깨져서 subtask가 누락되어도 null 반환 → 오케스트레이터가 단일 턴으로 폴백하지만 사용자에겐 "왜 멀티턴이 안 되지?" 의문.

**3) Telegram 봇 정지 실패 무시**

```js
// src/telegram.js L190
try { old.stop(); } catch { }
```

문제: 봇 정지가 실패하면 이전 봇과 새 봇이 동시에 폴링 → 메시지 중복 수신.

**4) 브라우저 탭 조회 실패 → 빈 배열**

```js
// server.js L810-812
app.get('/api/browser/tabs', async (_, res) => {
    try { res.json({ tabs: await browser.listTabs(cdpPort()) }); }
    catch { res.json({ tabs: [] }); }  // ← 에러 원인 은닉
});
```

문제: Chrome이 죽었는지, 포트가 잘못됐는지 구분 불가.

---

## 설계: 3-tier catch 정책

### Tier 1: 필수 로깅 (상 — 즉시 수정)

프로세스 제어, 네트워크, 보안 영역.

```js
// BEFORE
try { activeProcess.kill('SIGTERM'); } catch { }

// AFTER
try {
  activeProcess.kill('SIGTERM');
} catch (e) {
  console.warn('[agent:kill] SIGTERM failed', { pid: activeProcess?.pid, error: e.message });
}
```

### Tier 2: 조건부 로깅 (중 — Phase 9 내 처리)

JSON 파싱, 외부 서비스 응답.

```js
// BEFORE
try { return JSON.parse(fenced[1]).subtasks || null; } catch { }

// AFTER
try {
  return JSON.parse(fenced[1]).subtasks || null;
} catch (e) {
  console.debug('[orchestrator:subtask] JSON parse failed', { preview: String(fenced[1]).slice(0, 80) });
}
```

### Tier 3: 주석 명확화 (낮 — 보류 가능)

초기화 fallback, 파일 부재 감지.

```js
// BEFORE
} catch { return []; }

// AFTER
} catch { /* expected: skills dir may not exist yet */ return []; }
```

---

## 전수 백로그 (상/중 우선)

### 상 (10건) — 즉시 수정

| # | 파일 | 행 | 패턴 | 조치 |
|---|---|---|---|---|
| 1 | `server.js` | L812 | `catch { tabs:[] }` | warn + empty fallback |
| 2 | `server.js` | L846 | `catch { mcp-init }` | warn(이미 있음) — 유지 |
| 3 | `server.js` | L220 | WS message parse | warn with raw preview |
| 4 | `src/agent.js` | L28 | kill SIGTERM | warn with pid |
| 5 | `src/agent.js` | L31 | kill SIGKILL | warn with pid |
| 6 | `src/orchestrator.js` | L100 | subtask JSON #1 | debug with preview |
| 7 | `src/orchestrator.js` | L104 | subtask JSON #2 | debug with preview |
| 8 | `src/orchestrator.js` | L383 | flush JSON | debug |
| 9 | `src/telegram.js` | L190 | bot stop | warn with reason |
| 10 | `src/telegram.js` | L384,415 | parse/media | warn with msg id |

### 중 (8건) — Phase 9 내 처리

| # | 파일 | 행 | 패턴 | 조치 |
|---|---|---|---|---|
| 1 | `server.js` | L104 | quota creds | warn once |
| 2 | `server.js` | L112 | codex tokens | debug |
| 3 | `server.js` | L133,154 | fetch usage | debug + return null |
| 4 | `src/memory.js` | L53 | grep search | warn on proc error |
| 5 | `lib/mcp-sync.js` | (다수) | registry parse | warn + skip reason |
| 6 | `src/heartbeat.js` | L61 | file parse | debug |
| 7 | `src/acp-client.js` | L115 | JSON parse | debug |
| 8 | `src/config.js` | L129 | loadSettings | debug + path |

---

## 충돌 분석

| 대상 | 변경 | 충돌 위험 |
|---|---|---|
| `server.js` | 소규모 catch 블록 수정 | 낮음 — 한 줄 단위 |
| `src/agent.js` | L28, L31 | 낮음 |
| `src/orchestrator.js` | L100, L104, L383 | 낮음 |
| `src/telegram.js` | L190, L384, L415 | 낮음 |
| Phase 8.3 (라우트 분리) | 같은 server.js 영역 수정 | **병행 가능** — catch만 수정, 라우트 이동과 겹치지 않음 |

---

## 테스트 계획

catch 정책 변경은 **행동 변경이 없는** 리팩터링이므로 별도 테스트 파일은 불필요.
대신 아래로 검증:

### 1. 기존 테스트 회귀 확인

```bash
npm test
```

### 2. 로그 출력 확인 (수동)

```bash
# 의도적으로 에러 유발 후 console.warn 확인
curl localhost:3457/api/browser/tabs  # Chrome 미실행 시 warn 로그 확인
curl -X POST localhost:3457/api/skills/enable -d '{"id":"../evil"}'  # guard + warn
```

### 3. 조용한 catch 잔량 확인 스크립트

```bash
# 수정 후 "주석 없는 빈 catch" 잔량 확인
rg -n "catch \{" server.js src lib -g'*.js' | \
  rg -v "console\.(warn|error|debug|log|info)" | \
  rg -v "/\*" | \
  rg -v "expected|ok|fine|ignore|skip|first run"
```

목표: **상 등급 0건, 주석/로깅 없는 catch 5건 이하**.

---

## 완료 기준

- [ ] 상 등급 10건 모두 warn/debug 추가
- [ ] 중 등급 8건 중 최소 5건 처리
- [ ] 주석 없는 빈 catch 5건 이하
- [ ] 기존 `npm test` 통과
