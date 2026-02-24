# (fin) Phase 7.2 — Snapshot CDP 근본 수정 ✅

> 260223 다른 Mac에서도 동일하게 실패하는 snapshot 문제의 근본 원인 수정  
> **상태: 완료** — 로컬 스모크 테스트 + 서버 API 테스트 통과

---

## 문제

Phase 7.1에서 null guard를 추가했지만, `browser snapshot`은 **모든 CDP 연결에서** 여전히 실패:

```
Cannot read properties of undefined (reading 'snapshot')
// 또는 Phase 7.1 guard 적용 후:
Accessibility API unavailable — try reconnecting (browser stop → start)
```

### 근본 원인

`page.accessibility` 객체가 `chromium.connectOverCDP()` 연결에서 **항상 `undefined`**.
이는 Playwright의 알려진 제한사항:

> `connectOverCDP()` offers a lower fidelity connection compared to `browserType.connect()`.
> Certain advanced functionalities, including the accessibility tree, might not work reliably.

Phase 7.1의 null guard는 에러 메시지만 개선했을 뿐, 기능 자체는 고치지 못함.

---

## 수정 전략

`page.accessibility` (깨진 API) 완전 제거. 2단계 fallback으로 교체:

| 순서 | 전략                              | 동작 조건                | 반환 형태   |
| ---- | --------------------------------- | ------------------------ | ----------- |
| 1    | `locator.ariaSnapshot()`          | Playwright v1.49+ + CDP  | YAML → 파싱 |
| 2    | CDP `Accessibility.getFullAXTree` | CDPSession 직접 프로토콜 | AXNode[]    |

**Strategy 1**이 CDP 연결에서 정상 동작 확인 — Strategy 2는 fallback으로만 존재.

---

## 변경 파일

| 파일                        | 변경                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `src/browser/actions.js`    | `snapshot()` 완전 재작성 + `parseAriaYaml()`, `parseCdpAxTree()` 추가 |
| `src/browser/connection.js` | `getCdpSession(port)` export 추가                                     |
| `src/browser/index.js`      | `getCdpSession` export 추가                                           |

### actions.js 핵심 변경

```diff
-import { getActivePage } from './connection.js';
+import { getActivePage, getCdpSession } from './connection.js';

 export async function snapshot(port, opts = {}) {
     const page = await getActivePage(port);
     if (!page) throw new Error('No active page');
-    if (!page.accessibility) {
-        throw new Error('Accessibility API unavailable');
-    }
-    const tree = await page.accessibility.snapshot();
-    // ... walk tree ...
+
+    let nodes;
+    // Strategy 1: locator.ariaSnapshot() — CDP에서 동작 ✅
+    try {
+        const yaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
+        nodes = parseAriaYaml(yaml);
+    } catch (e1) {
+        // Strategy 2: direct CDP Accessibility.getFullAXTree
+        const cdp = await getCdpSession(port);
+        const { nodes: axNodes } = await cdp.send('Accessibility.getFullAXTree');
+        nodes = parseCdpAxTree(axNodes);
+    }
```

### 출력 포맷 (변경 없음)

```
e1   heading     "Example Domain"
e2   paragraph   ""
e3   paragraph   ""
e4     link      "Learn more"
```

`{ ref, role, name, value, depth }[]` — 기존 CLI/API 호환성 유지.

---

## 테스트 결과

### 개발 Mac (로컬, CDP 연결)

```
[test] launching Chrome...
[test] Chrome started
[test] navigating to example.com...
[test] navigated: { ok: true, url: 'https://example.com/' }
[test] taking snapshot...
[test] snapshot nodes (4):
e1   heading     "Example Domain"
e2   paragraph   ""
e3   paragraph   ""
e4     link      "Learn more"
[test] interactive snapshot...
[test] interactive nodes (1):
e4   link        "Learn more"
[test] ✅ ALL PASSED
```

---

## 체크리스트

- [x] `actions.js` — `page.accessibility` 제거, `ariaSnapshot()` 기반으로 교체
- [x] `actions.js` — `parseAriaYaml()` YAML 파서 추가
- [x] `actions.js` — `parseCdpAxTree()` CDP AX 노드 파서 추가
- [x] `connection.js` — `getCdpSession()` 추가
- [x] `index.js` — `getCdpSession` export
- [x] 로컬 스모크 테스트 통과
