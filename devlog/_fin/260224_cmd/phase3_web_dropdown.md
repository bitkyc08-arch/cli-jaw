# (fin) Phase 3: Web UI Command Dropdown

> 상태: ✅ 구현 완료 | 날짜: 2026-02-24
> 범위: `public/index.html`, `public/js/features/slash-commands.js`, `public/js/main.js`, `public/css/chat.css`
> 의존: Phase 2 (`POST /api/command`, `GET /api/commands`) ✔️ 완료

Phase 1(CLI autocomplete)과 같은 UX를 Web UI에 구현한다.
`/` 입력 시 입력창 위에 드롭다운이 나타나고, 화살표/Enter/ESC로 조작할 수 있다.

> 📝 **참고**: CLI Phase 1.2b에서는 드롭다운을 입력 **아래**로 고정했지만,
> Web UI에서는 입력창 **위**(`bottom: 100%`)가 UX 관념상 적합하다
> (Slack, Discord, VS Code palette 등과 동일 패턴).

---

## 목표 UX

```
+---------------------------------------+
|  /model     모델 확인/변경            |  ← highlighted
|  /mcp       MCP 목록/동기화/설치      |
|  /memory    메모리 검색/목록          |
+---------------------------------------+
| /m█                            [Send] |
+---------------------------------------+
```

- 입력창에 `/` 입력 시 커맨드 목록이 **위로** 펼쳐짐
- 문자 입력에 따라 실시간 필터링
- `↑/↓`으로 선택 이동 (highlight)
- `Enter` — 인자 없는 커맨드: 즉시 실행 / 인자 있는 커맨드: 입력창에 채움
- `Tab` — 선택 항목으로 입력 치환 (실행 안 함)
- `ESC` — 드롭다운 닫기
- 마우스 클릭 — 해당 항목 선택
- 드롭다운 외부 클릭 — 닫기

---

## 접근성 패턴 (Textarea + Listbox)

> 출처: [WAI-ARIA APG — Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
> 출처: [ARIA in HTML](https://w3c.github.io/html-aria/#docconformance)

`textarea`는 implicit role이 `textbox`이므로, 여기서는 strict combobox 1:1 대신
`textbox + listbox popup` 패턴으로 구현한다.
(`role="combobox"`를 `textarea`에 강제로 부여하지 않음)

```html
<div class="chat-input-area" style="position: relative;">
    <div id="cmdDropdown" class="cmd-dropdown" role="listbox"
         aria-label="커맨드 목록" style="display: none;">
        <!-- JS가 동적으로 채움 -->
    </div>
    <textarea id="chatInput"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="cmdDropdown"
              aria-autocomplete="list"
              aria-activedescendant="">
    </textarea>
</div>
```

> 🔧 **수정**: `.input-bar` → `.chat-input-area` (실제 index.html L58 기준)

### ARIA 속성 관리

| 상태             | `aria-expanded` | `aria-activedescendant` |
| ---------------- | --------------- | ----------------------- |
| 닫힘             | `false`         | `""`                    |
| 열림, 선택 없음  | `true`          | `""`                    |
| 열림, 3번째 선택 | `true`          | `"cmd-item-2"`          |

### 키보드 동작 (가이드라인 + 제품 정책)

| 키       | 드롭다운 닫힘                      | 드롭다운 열림                 |
| -------- | ---------------------------------- | ----------------------------- |
| `↓`      | 열기 + 첫 항목 (`/` 입력 상태)     | 다음 항목                     |
| `↑`      | 열기 + 마지막 항목 (`/` 입력 상태) | 이전 항목                     |
| `Enter`  | 메시지 전송                        | 선택 적용/실행                |
| `Escape` | -                                  | 닫기                          |
| `Tab`    | 기본 포커스 이동                   | 선택 적용 후 닫기 (제품 정책) |

> `Tab` 오버라이드는 APG 기본 포커스 이동과 다를 수 있으므로 제품 정책으로 명시한다.

---

## 구현 상세

### [MODIFY] `public/index.html`

입력 바 안에 dropdown DOM 추가:

```html
<!-- 기존 .chat-input-area 내부, textarea 위에 추가 -->
<div id="cmdDropdown" class="cmd-dropdown" role="listbox" style="display: none;"></div>
```

> ⚠️ `.chat-input-area`에 `position: relative`가 이미 있는지 확인 필요. 없으면 추가.

### [NEW] `public/js/features/slash-commands.js` (~120줄)

커맨드 드롭다운 로직을 독립 모듈로 분리:

```js
// ── Slash Command Dropdown ──

let cmdList = [];       // { name, desc, args, category }[]
let filtered = [];      // 현재 필터링된 목록
let selectedIdx = -1;   // -1 = 선택 없음
let isOpen = false;

const dropdown = () => document.getElementById('cmdDropdown');
const input = () => document.getElementById('chatInput');

// ── 1. 커맨드 목록 로드 (서버에서 1회 fetch) ──

export async function loadCommands() {
    try {
        const res = await fetch('/api/commands?interface=web');
        cmdList = await res.json();
    } catch {
        cmdList = [];
    }
}

// ── 2. 필터링 ──

function filterCommands(partial) {
    const prefix = partial.toLowerCase();
    return cmdList.filter(c => ('/' + c.name).startsWith(prefix));
}

// ── XSS 방지용 escape ──

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── 3. 렌더링 ──

function render() {
    const el = dropdown();
    // UX 반영 (W6): 빈 결과 시 안내 텍스트 표시
    if (!filtered.length) {
        if (input().value.startsWith('/')) {
            el.innerHTML = `<div class="cmd-item cmd-empty" style="color:var(--text-dim,#666);font-style:italic">
                일치하는 커맨드가 없습니다
            </div>`;
            el.style.display = 'block';
            el.classList.add('visible');
            return;
        }
        close(); return;
    }

    el.innerHTML = filtered.map((cmd, i) => {
        const isSelected = i === selectedIdx;
        return `<div class="cmd-item${isSelected ? ' selected' : ''}"
                     role="option"
                     id="cmd-item-${i}"
                     aria-selected="${isSelected}"
                     data-index="${i}">
            <span class="cmd-name">/${escapeHtml(cmd.name)}</span>
            <span class="cmd-desc">${escapeHtml(cmd.desc)}</span>
            ${cmd.args ? `<span class="cmd-args">${escapeHtml(cmd.args)}</span>` : ''}
        </div>`;
    }).join('');

    // 🔧 수정: cmd.name/desc/args를 escapeHtml()로 감싸 XSS 방지 (C1)

    el.style.display = 'block';
    // UX 반영 (W3): 등장 애니메이션 트리거
    requestAnimationFrame(() => el.classList.add('visible'));
    isOpen = true;

    // UX 반영 (W7): 선택 항목 스크롤 추적 (ARIA APG: scrollable listbox 가이드라인)
    const activeItem = el.querySelector('.cmd-item.selected');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });

    // ARIA 상태 업데이트갱신
    const inp = input();
    inp.setAttribute('aria-expanded', 'true');
    inp.setAttribute('aria-activedescendant',
        selectedIdx >= 0 ? `cmd-item-${selectedIdx}` : '');

    // 선택된 항목이 보이도록 스크롤
    const selected = el.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ── 4. 열기/닫기 ──

export function close() {
    const el = dropdown();
    // UX 반영 (W3): 퇴장 애니메이션
    el.classList.remove('visible');
    // transitionend 후 display:none (또는 즉시)
    setTimeout(() => {
        el.style.display = 'none';
        el.innerHTML = ''; // Clear content after it's hidden
    }, 150);
    isOpen = false;
    selectedIdx = -1;
    filtered = [];
    const inp = input();
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('aria-activedescendant', '');
}

export function update(text) {
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
        close();
        return;
    }
    filtered = filterCommands(text);
    if (!filtered.length) { close(); return; }
    selectedIdx = 0;
    render();
}

// ── 5. 키보드 네비게이션 ──

export function handleKeydown(e) {
    if (!isOpen) {
        // 닫힘 상태에서 ArrowDown/ArrowUp으로 열기 (슬래시 입력 상태일 때만)
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.isComposing) {
            const text = input().value;
            update(text);
            if (!isOpen) return false;
            selectedIdx = (e.key === 'ArrowUp') ? filtered.length - 1 : 0;
            render();
            e.preventDefault();
            return true;
        }
        return false; // 이벤트 미소비
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1);
        render();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(0, selectedIdx - 1);
        render();
        return true;
    }
    if (e.key === 'Tab') {
        // 제품 정책: 드롭다운이 열려 있으면 Tab으로 선택 적용
        e.preventDefault();
        applySelection(false);  // 입력만 치환, 실행 안 함
        return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        // 🔧 수정: isComposing 챔크 추가 — 한글 조합 중 Enter 방지 (M6)
        e.preventDefault();
        applySelection(true);   // 인자 없으면 즉시 실행
        return true;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
    }
    return false;
}

// ── 6. 선택 적용 ──

function applySelection(execute) {
    const cmd = filtered[selectedIdx];
    if (!cmd) { close(); return; }
    const inp = input();
    close();

    if (cmd.args || !execute) {
        // 인자 필요 또는 Tab: 입력창에 채움
        inp.value = `/${cmd.name} `;
        inp.focus();
        // 커서를 끝으로
        inp.selectionStart = inp.selectionEnd = inp.value.length;
    } else {
        // 인자 불필요 + Enter: 즉시 실행
        inp.value = `/${cmd.name}`;
        // sendMessage 트리거 (import 필요)
        inp.dispatchEvent(new Event('cmd-execute', { bubbles: true }));
    }
}

// ── 7. 마우스 클릭 ──

export function handleClick(e) {
    const item = e.target.closest('.cmd-item');
    if (!item) return;
    selectedIdx = parseInt(item.dataset.index, 10);
    applySelection(true);
}

// ── 8. 외부 클릭 닫기 ──

export function handleOutsideClick(e) {
    if (!isOpen) return;
    const el = dropdown();
    const inp = input();
    if (!el.contains(e.target) && e.target !== inp) {
        close();
    }
}

// ── 9. 상태 조회 ──

export function isDropdownOpen() {
    return isOpen;
}
```

### [MODIFY] `public/js/features/chat.js`

```diff
+ import * as slashCmd from './slash-commands.js';
+
  export async function sendMessage() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text && !state.attachedFile) return;
-     if (text === '/clear') { clearChat(); input.value = ''; return; }
+
+     // Slash command dispatch via server API
+     if (text.startsWith('/')) {
+         input.value = '';
+         slashCmd.close();
+         try {
+             const res = await fetch('/api/command', {
+                 method: 'POST',
+                 headers: { 'Content-Type': 'application/json' },
+                 body: JSON.stringify({ text }),
+             });
+             const result = await res.json();
+             if (result?.code === 'clear_screen') {
+                 document.getElementById('chatMessages').innerHTML = '';
+             }
+             if (result?.text) addSystemMsg(result.text);
+         } catch (err) {
+             addSystemMsg(`❌ 커맨드 실행 실패: ${err.message}`);
+         }
+         return;
+     }
```

### [MODIFY] `public/js/main.js`

```js
import { loadCommands, update, handleKeydown, handleClick, handleOutsideClick } from './features/slash-commands.js';

// 초기화 시 커맨드 목록 로드
loadCommands();

// Input 이벤트: 실시간 필터링
// UX 반영 (W2): rAF debounce로 빠른 타이핑 시 불필요한 DOM 재렌더 방지
let _rafId = 0;
document.getElementById('chatInput').addEventListener('input', (e) => {
    if (e.isComposing) return; // 한글 조합 중 필터링 스킵
    cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(() => update(e.target.value));
});

// Keydown: 드롭다운 네비게이션 (기존 handleKey보다 먼저)
document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (handleKeydown(e)) return;  // 소비됨
    // 기존 handleKey 로직 (Enter → sendMessage 등)
});

// 마우스 클릭
document.getElementById('cmdDropdown').addEventListener('click', handleClick);

// 외부 클릭
document.addEventListener('click', handleOutsideClick);

// 커스텀 이벤트: 인자 없는 커맨드 즉시 실행
document.getElementById('chatInput').addEventListener('cmd-execute', () => {
    sendMessage();
});
```

### [NEW/MODIFY] `public/css/chat.css`

```css
/* ── Command Dropdown ── */
.cmd-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--surface-1, #1e1e2e);
    border: 1px solid var(--border, #333);
    border-radius: 8px 8px 0 0;
    margin-bottom: 2px;
    max-height: 280px;
    overflow-y: auto;
    z-index: 100;
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.3);
    /* UX 반영 (W3): 등장/퇴장 애니메이션 */
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.15s ease-out, transform 0.15s ease-out;
    pointer-events: none;
}

.cmd-dropdown.visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}

.cmd-item {
    padding: 8px 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: background 0.1s;
}

.cmd-item:hover,
.cmd-item.selected {
    background: var(--surface-2, #2a2a3c);
}

.cmd-item.selected {
    border-left: 3px solid var(--accent, #f38ba8);
}

.cmd-name {
    color: var(--accent, #f38ba8);
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    min-width: 100px;
}

.cmd-desc {
    color: var(--text-dim, #999);
    font-size: 0.9em;
    flex: 1;
}

.cmd-args {
    color: var(--text-dim, #666);
    font-size: 0.8em;
    font-style: italic;
}

/* 스크롤바 스타일 */
.cmd-dropdown::-webkit-scrollbar {
    width: 4px;
}
.cmd-dropdown::-webkit-scrollbar-thumb {
    background: var(--border, #444);
    border-radius: 2px;
}
```

---

## 기존 `handleKey` 이벤트 충돌 해결

현재 `chat.js` L53-55:
```js
export function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
}
```

이것은 `main.js`에서 `addEventListener('keydown', handleKey)`로 바인딩되어 있을 것.
드롭다운이 열려있을 때 Enter는 **커맨드 선택**이어야 하므로:

```js
// main.js 수정
chatInput.addEventListener('keydown', (e) => {
    // 1. 드롭다운 열려있으면 드롭다운이 먼저 처리
    if (handleKeydown(e)) return;
    // 2. 아니면 기존 handleKey
    handleKey(e);
});
```

> ⚠️ 기존 `handleKey` 바인딩을 제거하고 위 통합 핸들러로 교체해야 함.

---

## IME(한글) 입력 호환성

```js
// input 이벤트에서 isComposing 체크
chatInput.addEventListener('input', (e) => {
    if (e.isComposing) return;  // 한글 조합 중에는 필터링 스킵
    update(e.target.value);
});
```

> `isComposing`이 true인 동안은 `/ㅁ` 같은 미완성 입력을 필터링하지 않는다.
> 조합 완료 후(`compositionend`) 자동으로 input 이벤트가 다시 발생하므로 그때 필터링.

---

## 영향 파일

| 파일                                         | 변경                              | 라인       |
| -------------------------------------------- | --------------------------------- | ---------- |
| `public/index.html`                          | dropdown DOM 추가 + ARIA 속성     | ~5줄       |
| `public/js/features/slash-commands.js` [NEW] | 드롭다운 전체 로직                | ~120줄     |
| `public/js/features/chat.js`                 | `/clear` 하드코드 → 통합 디스패치 | ~20줄 변경 |
| `public/js/main.js`                          | 이벤트 바인딩 + loadCommands      | ~15줄 추가 |
| `public/css/chat.css`                        | 드롭다운 스타일                   | ~50줄 추가 |

## 난이도 & 공수

| 항목                   | 난이도 | 공수    |
| ---------------------- | ------ | ------- |
| slash-commands.js 모듈 | 🟡      | 1.5h    |
| chat.js 디스패치 교체  | 🟢      | 20m     |
| main.js 이벤트 연결    | 🟡      | 30m     |
| CSS 스타일링           | 🟢      | 30m     |
| index.html DOM         | 🟢      | 10m     |
| ARIA 접근성            | 🟡      | 20m     |
| IME 호환성             | 🟡      | 20m     |
| 브라우저 테스트        | 🟡      | 30m     |
| **합계**               |        | **~4h** |

---

## 구현 결과 (계획 외 추가 사항)

| 추가 항목                                            | 파일                | 효과                                                                   |
| ---------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `closeTimer` 중복 방지                               | `slash-commands.js` | close 중 showDropdown 재호출 시 `clearTimeout`으로 race condition 방지 |
| `color-mix(in srgb, var(--accent) 10%, transparent)` | `chat.css`          | hover 배경에 accent 10% 혼합 — 디자인 시스템 변수와 자연스러운 조화    |
| `scroll-margin-block: 4px`                           | `chat.css`          | `scrollIntoView` 시 선택 항목 상하 여백 확보                           |
| `cmd-execute` 커스텀 이벤트                          | `main.js`           | `void sendMessage()`로 바인딩 — JS 모듈 간 깨끗한 분리                 |
| `position: absolute` + `left/right: 20px`            | `chat.css`          | input-area padding과 드롭다운 좌우 여백 일치                           |
| `slash-commands.js` 220줄 (계획 120줄)               | -                   | ARIA, 빈결과 UI, 애니메이션 등 UX 개선으로 규모 증가                   |

---

## 향후 개선 (Phase 3+)

| 항목                          | 설명                                                                     | 상태         |
| ----------------------------- | ------------------------------------------------------------------------ | ------------ |
| argument stage 확장           | `update()`가 공백 포함 시 즉시 닫힘 → Phase 4 인자 자동완성 시 분기 필요 | 🟡 Phase 4 때 |
| `loadCommands` 에러 로깅      | catch에서 사일런트 처리 → `console.warn` 추가 권장                       | 🟢            |
| 모바일 `visualViewport`       | 터치 키보드 위에 드롭다운이 가려질 수 있음 (W4)                          | 🟢            |
| Web전용 응답 `type` 색상 분기 | 응답 `type` 필드 이미 추가됨 → `addSystemMsg`에서 색상 분기 구현 필요    | 🟡            |

## 리스크

| 리스크                               | 확률 | 영향 | 대응                                       |
| ------------------------------------ | ---- | ---- | ------------------------------------------ |
| keydown 이벤트 충돌 (기존 handleKey) | 높음 | 높음 | 통합 핸들러로 교체                         |
| IME 한글 조합 중 오동작              | 보통 | 보통 | `isComposing` 체크 + `compositionend` 대응 |
| CSS 변수 미정의 fallback             | 낮음 | 낮음 | fallback 값 명시                           |
| `POST /api/command` 응답 지연        | 낮음 | 낮음 | loading 상태 표시                          |
| 모바일 터치 UX                       | 보통 | 보통 | W4: `visualViewport` API로 가시 영역 계산  |
| Phase 4 인자 자동완성 미대응         | 보통 | 높음 | W8: argument stage 확장 가능 구조 필요     |

## 검증

### 브라우저 테스트

```
1. http://localhost:3457 접속
2. 입력창에 `/` 타이핑 → 드롭다운 표시 확인
3. `/m` 입력 → `/model`, `/mcp`, `/memory` 필터링
4. ↓ 키 → highlight 이동
5. ↑ 키 → highlight 역방향 이동
6. Tab → 선택 커맨드 입력창에 채움 (e.g. `/model `)
7. Enter (인자 없는 커맨드) → 즉시 실행 + 시스템 메시지
8. Enter (인자 있는 커맨드) → 입력창에 `/{cmd} ` 채움
9. ESC → 드롭다운 닫힘, 입력 보존
10. 마우스 클릭 → 해당 항목 선택
11. 드롭다운 외부 클릭 → 닫힘
12. 한글 입력 (`/ㅁ` → `/모` → `/모델`) → 오류 없이 작동
13. `/clear` → 채팅 영역 초기화 (이전 동작 유지 확인)
14. `/foobar` → 시스템 메시지: "알 수 없는 커맨드"
```

### Phase 2 의존성 확인

- `GET /api/commands` 동작 확인 (Phase 2)
- `POST /api/command` 동작 확인 (Phase 2)

---

## CLI/Web/Telegram UX 비교

| 기능        | CLI (Phase 1)           | Web (Phase 3)                | Telegram (Phase 2)           |
| ----------- | ----------------------- | ---------------------------- | ---------------------------- |
| `/` 힌트    | ANSI popup below input  | DOM dropdown above input     | Telegram 내장 `/` 메뉴       |
| 키보드 이동 | ↑/↓ raw ESC sequences   | ↑/↓ keydown events           | N/A (터치)                   |
| 선택        | Tab/Enter               | Tab/Enter/Click              | 터치 선택                    |
| 닫기        | ESC                     | ESC/외부 클릭                | 자동                         |
| 커맨드 실행 | executeCommand(ctx=cli) | POST /api/command            | executeCommand(ctx=telegram) |
| 결과 표시   | console.log             | 시스템 메시지 (addSystemMsg) | ctx.reply                    |
