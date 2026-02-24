# Phase 20.5: 폴리시 — innerHTML XSS 감사 + Accessibility + Mobile 반응형

> Round 5: 프론트엔드 보안/접근성/반응형 최종 점검.

---

## 20.5-A: innerHTML XSS 감사 + 수정

### escapeHtml 강화 (P0 — 속성 컨텍스트 XSS 방지)

#### 파일: `public/js/render.js`

```diff
 export function escapeHtml(t) {
-    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
+    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
+            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
 }
```

> `"` 미이스케이프 시 `value="${escapeHtml(...)}"` 패턴에서 속성 탈출 XSS 가능.

### 감사 결과 (현재 상태)

| 파일 | 줄 | 현재 | 위험도 | 조치 |
|---|---|---|---|---|
| `ui.js` L83 | `content.innerHTML = toolHtml + renderMarkdown(text)` | renderMarkdown 내부에서 sanitizeHtml 호출 ✅ | 안전 | 유지 |
| `ui.js` L96 | `div.innerHTML = ...getAppName()...renderMarkdown...` | renderMarkdown 경유 ✅ | 안전 | 유지 |
| `ui.js` L144 | `list.innerHTML = ...escapeHtml(m.key)...escapeHtml(m.value)` | escapeHtml ✅ | 안전 | 유지 |
| `employees.js` L20 | `el.innerHTML = state.employees.map(a => { ... })` | escapeHtml 이미 적용 ✅ | 안전 | 유지 |
| `employees.js` L103 | `sel.innerHTML = models.map(m => ...)` | **model 이름 미이스케이프** | ⚠️ 중간 | 수정 |
| `heartbeat.js` L23 | `container.innerHTML = state.heartbeatJobs.map(...)` | **job.name, job.prompt → 미이스케이프** | ⚠️ 중간 | 수정 |
| `skills.js` L32 | `list.innerHTML = filtered.map(s => ...)` | **s.name, s.description → 미이스케이프** | ⚠️ 중간 | 수정 |
| `memory.js` L61 | `container.innerHTML = files.map(f => ...)` | f.name은 서버 생성 파일명 | 낮음 | escapeHtml 추가 |
| `memory.js` L83 | `container.innerHTML = ...escapeHtml(data.content)` | escapeHtml ✅ | 안전 | 유지 |

### 수정

#### `public/js/features/employees.js`

```diff
 import { escapeHtml } from '../render.js';
 
 // L103 — model select: 이름 미이스케이프 수정
-    sel.innerHTML = `<option value="default" selected>default</option>` + models.map(m => `<option>${m}</option>`).join('');
+    sel.innerHTML = `<option value="default" selected>default</option>` + models.map(m => `<option>${escapeHtml(m)}</option>`).join('');
```

> L20 employee 카드 렌더링은 이미 escapeHtml 적용 확인 ✅ — 수정 불필요.

#### `public/js/features/heartbeat.js`

```diff
+import { escapeHtml } from '../render.js';
 
         container.innerHTML = state.heartbeatJobs.map((job, i) => `
             <div class="hb-job-card">
                 <div class="hb-job-header">
-                    <input type="text" value="${job.name || ''}" placeholder="${t('hb.name')}"
+                    <input type="text" value="${escapeHtml(job.name || '')}" placeholder="${t('hb.name')}"
                         data-hb-name="${i}">
                     <!-- ... -->
                 </div>
-                <textarea class="hb-prompt" rows="2" placeholder="${t('hb.prompt')}"
-                    data-hb-prompt="${i}">${job.prompt || ''}</textarea>
+                <textarea class="hb-prompt" rows="2" placeholder="${t('hb.prompt')}"
+                    data-hb-prompt="${i}">${escapeHtml(job.prompt || '')}</textarea>
             </div>
         `).join('');
```

#### `public/js/features/skills.js`

```diff
+import { escapeHtml } from '../render.js';
 
     list.innerHTML = filtered.map(s => {
         // ...
         return `
         <div class="skill-card ${s.enabled ? 'enabled' : ''}">
             <div class="skill-card-header">
-                <span class="skill-emoji">${s.emoji || '🔧'}</span>
-                <span class="skill-name">${s.name || s.id}</span>
+                <span class="skill-emoji">${escapeHtml(s.emoji || '🔧')}</span>
+                <span class="skill-name">${escapeHtml(s.name || s.id)}</span>
                 <button class="skill-toggle ${s.enabled ? 'on' : 'off'}"
-                        data-skill-id="${s.id}" data-skill-enabled="${s.enabled}"></button>
+                        data-skill-id="${escapeHtml(s.id)}" data-skill-enabled="${s.enabled}"></button>
             </div>
-            <div class="skill-desc">${s.description || ''}</div>
+            <div class="skill-desc">${escapeHtml(s.description || '')}</div>
             ${reqParts.length ? `<div class="skill-req">${reqParts.join(' · ')}</div>` : ''}
         </div>`;
     }).join('');
```

#### `public/js/features/memory.js`

```diff
     container.innerHTML = files.map(f => `
-        <div class="mem-file-card" data-mem-file="${f.name}">
-            <span class="mem-file-name">${f.name}</span>
+        <div class="mem-file-card" data-mem-file="${escapeHtml(f.name)}">
+            <span class="mem-file-name">${escapeHtml(f.name)}</span>
             <span class="mem-file-meta">${f.entries} entries · ${(f.size/1024).toFixed(1)}KB</span>
```

---

## 20.5-B: Accessibility 개선

### 파일: `public/index.html`

```diff
 <!-- Left Sidebar -->
-<div class="sidebar-left">
+<nav class="sidebar-left" role="navigation" aria-label="Main navigation">
-    <button class="sidebar-toggle" id="toggleLeft" title="Collapse">◀</button>
+    <button class="sidebar-toggle" id="toggleLeft" title="Collapse" aria-label="Collapse sidebar">◀</button>

 <!-- Memory sidebar button -->
-    <button class="sidebar-hb-btn" id="memorySidebarBtn">🧠 Memory (0)</button>
+    <button class="sidebar-hb-btn" id="memorySidebarBtn" aria-label="Open memory panel">🧠 Memory (0)</button>

 <!-- Right Sidebar -->
-<div class="sidebar-right">
+<aside class="sidebar-right" role="complementary" aria-label="Settings panel">
-    <button class="sidebar-toggle" id="toggleRight" title="Collapse">▶</button>
+    <button class="sidebar-toggle" id="toggleRight" title="Collapse" aria-label="Collapse settings">▶</button>

 <!-- Modals -->
-<div class="modal-overlay" id="promptModal">
+<div class="modal-overlay" id="promptModal" role="dialog" aria-modal="true" aria-label="System prompt editor">

-<div class="modal-overlay" id="heartbeatModal">
+<div class="modal-overlay" id="heartbeatModal" role="dialog" aria-modal="true" aria-label="Heartbeat jobs">

-<div class="modal-overlay" id="memoryModal">
+<div class="modal-overlay" id="memoryModal" role="dialog" aria-modal="true" aria-label="Memory files">

 <!-- Chat input -->
 <textarea id="chatInput"
+    aria-label="Chat message input"
     placeholder="메시지 입력..."
```

### 파일: `public/js/features/chat.js` (Escape로 모달 닫기)

```diff
+// ─── Keyboard: Escape closes modals ─────────────────
+document.addEventListener('keydown', (e) => {
+    if (e.key === 'Escape') {
+        document.querySelectorAll('.modal-overlay.open').forEach(m => {
+            m.classList.remove('open');
+        });
+    }
+});
```

### 파일: `public/css/variables.css` (포커스 스타일)

```diff
+/* ─── Focus visible ──────────────────────────────── */
+:focus-visible {
+    outline: 2px solid var(--accent);
+    outline-offset: 2px;
+}
+
+button:focus-visible,
+input:focus-visible,
+textarea:focus-visible,
+select:focus-visible {
+    outline: 2px solid var(--accent);
+    outline-offset: 1px;
+}
```

---

## 20.5-C: Mobile 반응형 기본 대응

### 파일: `public/css/layout.css`

> ⚠️ 기존 @media (max-width: 900px)에서 `body.left-expanded` / `body.right-expanded` 클래스 시스템을 이미 사용 중.
> 새 모바일 룰은 이 시스템과 통합해야 함. `.sidebar-left.open` 같은 별도 클래스 사용 금지.

```diff
-/* 기존 900px 규칙은 유지하되, 768px 이하 추가 강화 */
+/* ─── Mobile: ≤ 768px 추가 강화 (기존 900px 규칙과 통합) ─── */
 @media (max-width: 768px) {
     body {
         grid-template-columns: 1fr;
         grid-template-areas: "main";
     }

+    /* 기존 body.left-expanded / body.right-expanded 클래스와 통합 */
     .sidebar-left,
     .sidebar-right {
         position: fixed;
         top: 0;
         bottom: 0;
         z-index: 100;
         width: 280px;
         transform: translateX(-100%);
         transition: transform 0.2s ease;
     }

     .sidebar-right {
         right: 0;
         left: auto;
         transform: translateX(100%);
     }

+    /* 기존 토글 시스템과 동일한 body 클래스 사용 */
+    body.left-expanded .sidebar-left {
         transform: translateX(0);
     }

+    body.right-expanded .sidebar-right {
         transform: translateX(0);
     }

     /* Mobile toggle buttons */
     .mobile-nav {
         display: flex;
         position: fixed;
         bottom: 0;
         left: 0;
         right: 0;
         z-index: 99;
         background: var(--bg-sidebar);
         border-top: 1px solid var(--border);
         padding: 8px;
         gap: 8px;
         justify-content: space-around;
     }
 }
+
+@media (min-width: 769px) {
+    .mobile-nav { display: none; }
+}
```

### 파일: `public/index.html` (하단에 모바일 네비 추가)

```diff
+    <!-- Mobile Navigation -->
+    <div class="mobile-nav">
+        <button id="mobileMenuLeft" aria-label="Open menu">☰ Menu</button>
+        <button id="mobileMenuRight" aria-label="Open settings">⚙️ Settings</button>
+    </div>
```

### 파일: `public/js/main.js` (모바일 토글 바인딩)

```diff
+// ── Mobile sidebar toggle (기존 body 클래스 시스템 재사용) ──
+document.getElementById('mobileMenuLeft')?.addEventListener('click', () => {
+    document.body.classList.toggle('left-expanded');
+    document.body.classList.remove('right-expanded');
+});
+document.getElementById('mobileMenuRight')?.addEventListener('click', () => {
+    document.body.classList.toggle('right-expanded');
+    document.body.classList.remove('left-expanded');
+});
```

---

## 테스트 계획

```bash
# XSS: 수동 테스트
# 1. 스킬 이름에 <img onerror=alert(1)> 주입 시도 → escapeHtml 동작 확인
# 2. heartbeat job name에 <script>alert(1)</script> 입력 → 이스케이프 확인

# Accessibility: Lighthouse 또는 수동
# 1. Tab 키로 모든 인터랙티브 요소 순회 가능
# 2. 모달 열기/닫기 Escape 동작
# 3. Screen reader에서 aria-label 읽힘

# Mobile: DevTools 반응형 모드
# 1. 375px (iPhone SE) 레이아웃
# 2. 768px 미만에서 사이드바 숨김/토글
# 3. 하단 네비 표시

npm test
```

---

## 완료 기준

- [ ] innerHTML 모든 사용처에 escapeHtml 적용 확인 (감사 표 기준)
- [ ] 4개 파일 XSS 패치: employees, heartbeat, skills, memory
- [ ] 사이드바/모달에 ARIA role + aria-label 추가
- [ ] `:focus-visible` 스타일 추가
- [ ] Escape로 모달 닫기
- [ ] 768px 미만 모바일 레이아웃 동작
- [ ] 모바일 하단 네비 표시
- [ ] `npm test` 통과
