# (fin) Phase 7.1 — 브라우저 버그 수정 + MCP Puppeteer 제거 + reset 커맨드

> 260223 다른 컴퓨터 테스트에서 발견된 이슈 + 정리

---

## 테스트 결과 (M4 Mac Mini)

browser 스킬로 탐색 테스트 완료:

| 기능                 | 결과                                                         |
| -------------------- | ------------------------------------------------------------ |
| `browser start`      | ✅ CDP 127.0.0.1:9240 리슨 확인                               |
| `browser navigate`   | ✅ example.com, DCInside 이동 성공                            |
| `browser evaluate`   | ✅ `document.title` → "Example Domain"                        |
| `browser text`       | ✅ 본문 추출 성공                                             |
| `browser screenshot` | ✅ 저장 성공                                                  |
| `browser snapshot`   | ❌ `Cannot read properties of undefined (reading 'snapshot')` |

---

## 7.1.1 Snapshot 에러 수정

### 원인

`page.accessibility.snapshot()` 호출 시 CDP 연결된 페이지에서 `page.accessibility` 객체 자체가 `undefined`.
Playwright의 `chromium.connectOverCDP()`로 연결 시 accessibility API가 완전히 초기화되지 않는 경우 존재.

### 수정 (`src/browser/actions.js`)

```diff
 export async function snapshot(port, opts = {}) {
     const page = await getActivePage(port);
     if (!page) throw new Error('No active page');
+    if (!page.accessibility) {
+        throw new Error('Accessibility API unavailable — try reconnecting (browser stop → start)');
+    }
     const tree = await page.accessibility.snapshot();
+    if (!tree) throw new Error('Accessibility snapshot returned empty — page may still be loading');
```

null guard로 에러 메시지 개선. 기존 `Cannot read properties of undefined` 대신 명확한 안내.

---

## 7.1.2 MCP Puppeteer 제거

CLI-Claw 자체 브라우저 모듈(`src/browser/`)이 Playwright CDP로 동작하므로 MCP Puppeteer는 불필요.

### 변경 파일

| 파일                  | 변경                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `lib/mcp-sync.js`     | `DEFAULT_MCP_SERVERS`에서 puppeteer 제거, `NPX_TO_GLOBAL` 매핑 제거 |
| `bin/postinstall.js`  | `MCP_PACKAGES`에서 puppeteer 제거                                   |
| `bin/commands/mcp.js` | 예시 텍스트 `server-puppeteer` → `server-filesystem`                |
| `README.md`           | MCP 서버 테이블, 기능 목록, 요구사항에서 puppeteer 삭제             |

기본 MCP: **context7만 유지**.

---

## 7.1.3 `browser reset` 커맨드 추가

`skill reset --force` 패턴과 동일한 UX.

### 사용법

```bash
cli-claw browser reset           # 확인 프롬프트 후 초기화
cli-claw browser reset --force   # 확인 없이 초기화
```

### 동작

1. `browser stop` (서버 통신, 실패 무시)
2. `~/.cli-claw/browser-profile/` 삭제
3. `~/.cli-claw/screenshots/` 삭제

### 변경 파일

| 파일                      | 변경                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `bin/commands/browser.js` | `reset` case 추가 + imports (`rmSync`, `existsSync`, `homedir`, `join`) + help 텍스트 업데이트 |

---

## 체크리스트

- [x] 7.1.1: snapshot null guard (`src/browser/actions.js`)
- [x] 7.1.2: MCP Puppeteer 제거 (`mcp-sync.js`, `postinstall.js`, `mcp.js`, `README.md`)
- [x] 7.1.3: `browser reset [--force]` (`bin/commands/browser.js`)
