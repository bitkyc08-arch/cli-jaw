# (fin) Phase 2~3 보안/QA 심층 검토

> 검토 날짜: 2026-02-24
> 범위: `phase2_server_telegram.md`, `phase3_web_dropdown.md`
> 등급: 사이버 공격 QA 수준

---

## 🔴 Critical — 즉시 수정 필요

### C1. Phase 3 — XSS via innerHTML (Stored XSS)

```js
// phase3_web_dropdown.md L129
el.innerHTML = filtered.map((cmd, i) => {
    return `<span class="cmd-name">/${cmd.name}</span>
            <span class="cmd-desc">${cmd.desc}</span>`;
}).join('');
```

**공격 벡터**: `GET /api/commands` 응답이 `cmd.name`이나 `cmd.desc`에 HTML을 포함하면 **Stored XSS** 발생.

현재 `COMMANDS` 배열은 소스코드 내 하드코딩이라 실질 위험은 낮지만:
1. 향후 사용자 커스텀 커맨드 추가 시 → 직접 XSS
2. MITM(중간자 공격) 또는 서버 응답 조작 시 → Reflected XSS
3. `cmd.args`에 `<img onerror=...>` 같은 payload 가능

**수정안**:

```js
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// render() 안에서:
`<span class="cmd-name">/${escapeHtml(cmd.name)}</span>
 <span class="cmd-desc">${escapeHtml(cmd.desc)}</span>
 ${cmd.args ? `<span class="cmd-args">${escapeHtml(cmd.args)}</span>` : ''}`
```

또는 **DOM API 사용** (더 안전):

```js
const div = document.createElement('div');
div.className = `cmd-item${isSelected ? ' selected' : ''}`;
div.setAttribute('role', 'option');
const nameSpan = document.createElement('span');
nameSpan.className = 'cmd-name';
nameSpan.textContent = `/${cmd.name}`;  // textContent는 자동 escape
div.appendChild(nameSpan);
```

**심각도**: 🔴 Critical (XSS는 항상 Critical)

---

### C2. Phase 2 — Telegram result.text → ctx.reply 무이스케이프

```js
// phase2 L152-154
if (result?.text) {
    try {
        await ctx.reply(result.text);
    } catch {
        await ctx.reply(result.text.slice(0, 4000));
    }
}
```

**문제**: `ctx.reply(text)`는 `parse_mode` 미지정 시 plain text로 전송되므로 HTML 인젝션은 안 됨. 
**그러나**: 일부 핸들러가 result.text에 이미 마크다운/HTML을 포함할 수 있음.

특히 `helpHandler`의 출력에 `/${cmd.name} — ${cmd.desc}` 형태가 있는데,

```
/model <provider/model> — 모델 확인/변경
```

여기서 `<provider/model>`은 Telegram이 `parse_mode: 'HTML'`과 함께 해석하면 **태그로 인식**될 수 있음.

**현재 계획에서는 parse_mode 미지정이므로 안전**하지만, 향후 HTML 포매팅 추가 시 위험.

**수정안**: 명시적으로 `parse_mode` 없이 전송하되, 주석으로 경고:

```js
// ⚠️ parse_mode 미지정 = plain text. 
// result.text에 HTML/Markdown 포함 시 parse_mode 추가 전에 sanitize 필수.
await ctx.reply(result.text, { parse_mode: undefined });
```

**심각도**: 🟡 Medium (현재는 안전, 미래 위험)

---

## 🟠 High — 설계 결함

### H1. Phase 2 — Telegram ctx가 self-request 사용 (§3.2 위반)

```js
// phase2 L170-172
getSession: async () => {
    const res = await fetch(`http://localhost:${settings.port || 3457}/api/session`);
    return res.json();
},
```

**문제**: slash_commands.md §3.2 원칙은 "self-request 금지"임.
CLI ctx는 `apiJson()` 사용, Web ctx는 직접 함수 호출하는데, **TG ctx만 localhost fetch를 사용**.

**이유**: telegram.js는 server.js와 같은 프로세스에서 돌지만 직접 import가 복잡.

**리스크**:
- 서버 포트가 변경되면 깨짐
- 요청 자기 자신 → 이벤트 루프 blocker (async이므로 데드락은 안 되지만 불필요한 오버헤드)
- 테스트 mocking 어려움

**수정안**: Web ctx와 동일하게 직접 함수 import:

```js
// telegram.js에서 직접 import
import { getSession, settings } from './config.js';
// 또는 initTelegram()에 ctx factory를 파라미터로 주입
export function initTelegram(ctxFactory) { ... }
```

**심각도**: 🟠 High (설계 원칙 위반 + 안정성)

---

### H2. Phase 2 — POST /api/command에 에러 응답 누락

```js
// phase2 L59-60
const result = await executeCommand(parsed, ctx);
res.json(result);
```

**문제**: `executeCommand`가 내부적으로 try/catch하지만, 
ctx 구성 중 함수(예: `getSession`)가 에러를 던지면 **Express 기본 500 에러**가 나옴.

**수정안**:

```js
app.post('/api/command', async (req, res) => {
    try {
        // ... existing logic
        const result = await executeCommand(parsed, ctx);
        res.json(result);
    } catch (err) {
        console.error('[cmd:error]', err);
        res.status(500).json({
            ok: false, code: 'internal_error',
            text: `서버 오류: ${err.message}`,
        });
    }
});
```

**심각도**: 🟠 High (unhandled rejection → 서버 크래시 가능)

---

### H3. Phase 3 — cmd-execute 커스텀 이벤트 순환 호출

```js
// phase3 L232-234
inp.value = `/${cmd.name}`;
inp.dispatchEvent(new Event('cmd-execute', { bubbles: true }));
```

그리고:
```js
// main.js L324
chatInput.addEventListener('cmd-execute', () => {
    sendMessage();
});
```

**문제**: `sendMessage()`가 `text.startsWith('/')` 체크 → `POST /api/command` 실행.
**여기서 서버가 `{ code: 'clear_screen' }`을 반환하면 OK인데**:
`sendMessage()`가 `input.value = ''`로 먼저 비우고 fetch하므로,
**cmd-execute 시점에 input.value가 아직 안 비워질 수 있음**.

실제로 `applySelection`에서 `inp.value = '/${cmd.name}'` 설정 직후 `cmd-execute` 발생하므로
`sendMessage()`는 올바른 값을 읽음. **시퀀싱은 OK**.

하지만 `close()`가 `inp.value = ''`를 안 하므로 **실제로 안전**.

**그래도 문제**: `dispatchEvent`는 **동기적**임. 
`sendMessage()` 안에서 `slashCmd.close()`를 또 호출하는데 이미 close() 상태.
→ **double close는 안전** (innerHTML = '' 중복).

**최종 판정**: 🟡 Medium. 동작은 되지만 이벤트 흐름 추적이 어려움.
→ `applySelection`에서 직접 `sendMessage()` import 호출이 더 명확.

---

## 🟡 Medium — 개선 권장

### M1. Phase 2 — 입력 길이 제한 없음

```js
const text = (req.body?.text || '').trim();
```

**공격 벡터**: 10MB 페이로드 전송 → 메모리 과다 사용.

**수정안**:
```js
const text = (req.body?.text || '').trim().slice(0, 500);
```

---

### M2. Phase 2 — GET /api/commands interface 파라미터 인젝션

```js
const iface = req.query.interface || 'web';
res.json(COMMANDS.filter(c => c.interfaces.includes(iface)));
```

**공격 벡터**: `?interface=__proto__` 같은 입력.
`Array.includes('__proto__')`는 단순 문자열 비교이므로 **실제 위험은 없음**.
하지만 `?interface=*`로 hidden 커맨드 노출은 안 됨 (includes는 exact match).

**판정**: 🟢 안전. 추가 검증 불필요.

---

### M3. Phase 3 — loadCommands() 1회 호출 후 캐시

```js
export async function loadCommands() {
    cmdList = await fetch('/api/commands?interface=web').then(r => r.json());
}
```

**문제**: 페이지 로드 시 1회만 fetch. 핫리로드나 커맨드 추가 시 반영 안 됨.

**수정안**: 캐시 TTL 또는 focus 시 재로드:
```js
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadCommands();
});
```

---

### M4. Phase 3 — selectedIdx 범위 초과 가능

```js
selectedIdx = parseInt(item.dataset.index, 10);
```

**공격 벡터**: DOM 조작으로 `data-index="999"` 설정.
→ `filtered[999]` = undefined → `applySelection`에서 `if (!cmd) { close(); return; }` 방어됨. ✅

**판정**: 방어 있음, 안전.

---

### M5. Phase 2 — `bot.command('start')` vs `on('message:text')` 충돌

```js
bot.command('start', ctx => ctx.reply('...'));
// ...
bot.on('message:text', async (ctx) => {
    if (text.startsWith('/')) {
        const parsed = parseCommand(text);
```

**Grammy 동작**: `bot.command('start')`는 내부적으로 `on('message:text')` 패턴으로
`/start` 메시지를 먼저 처리하고 `next()`를 호출하지 않으므로
**후속 `on('message:text')` 핸들러에 `/start`가 도달하지 않음**. ✅

단, BotFather에 등록된 커맨드(`/start`, `/id`)와 COMMANDS 레지스트리 커맨드가
**중복 등록되면** `setMyCommands`에 `/start`가 두 번 들어갈 수 있음.

**수정안**: `syncTelegramCommands`에서 BotFather 예약 커맨드 제외:

```js
const RESERVED = new Set(['start', 'help', 'settings']);
COMMANDS
    .filter(c => c.interfaces.includes('telegram') && !RESERVED.has(c.name))
    .map(...)
```

---

### M6. Phase 3 — 키보드 이벤트에서 isComposing 미사용 누락

현재 Plan의 `handleKeydown()`:
```js
if (e.key === 'Enter' && !e.shiftKey) {
```

**`e.isComposing` 체크가 없음**. 한글 "ㅁ" 조합 중 Enter → 조합 확정 아닌 커맨드 실행이 될 수 있음.

**수정안**:
```js
if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
```

---

## 🟢 Low — 개선하면 좋음

### L1. Phase 2 — Telegram 커맨드 description 길이 제한

Telegram BotFather는 커맨드 description을 **3~256자**로 제한.
현재 계획에서 `cmd.desc`가 256자를 초과하면 `setMyCommands`가 실패.

**수정안**: `.slice(0, 256)` truncate.

---

### L2. Phase 3 — 접근성: 드롭다운 라이브 리전

현재 ARIA 속성은 있지만, 스크린 리더에 선택 변경을 알리는 **라이브 리전**이 없음.

```html
<div role="status" aria-live="polite" class="sr-only" id="cmdStatus"></div>
```

---

### L3. Phase 2 — CORS/CSRF 방어 확인

`POST /api/command`에 CORS나 CSRF 토큰이 없으면 
외부 사이트에서 `fetch('http://localhost:3457/api/command')` 가능.

**현재 상태**: 로컬 전용 서버이므로 실질 위험은 극히 낮음.
하지만 `CORS: same-origin`이나 간단한 `X-Requested-With` 헤더 체크 추가 권장.

---

## 요약 매트릭스

| ID  | 심각도     | Phase | 분류      | 제목                                   |
| --- | ---------- | ----- | --------- | -------------------------------------- |
| C1  | 🔴 Critical | 3     | XSS       | innerHTML에서 cmd.name/desc 미검증     |
| C2  | 🟡 Medium   | 2     | Injection | TG reply에서 미래 HTML parse_mode 위험 |
| H1  | 🟠 High     | 2     | 설계      | TG ctx self-request (§3.2 위반)        |
| H2  | 🟠 High     | 2     | 에러      | POST /api/command try/catch 누락       |
| H3  | 🟡 Medium   | 3     | 설계      | cmd-execute 이벤트 흐름 복잡성         |
| M1  | 🟡 Medium   | 2     | DoS       | 입력 길이 무제한                       |
| M3  | 🟡 Medium   | 3     | UX        | 커맨드 목록 캐시 미갱신                |
| M5  | 🟡 Medium   | 2     | 충돌      | BotFather 예약 커맨드 중복             |
| M6  | 🟡 Medium   | 3     | IME       | handleKeydown isComposing 누락         |
| L1  | 🟢 Low      | 2     | API       | TG description 길이 제한               |
| L2  | 🟢 Low      | 3     | A11y      | 라이브 리전 없음                       |
| L3  | 🟢 Low      | 2     | CSRF      | 로컬 API CSRF 방어                     |

