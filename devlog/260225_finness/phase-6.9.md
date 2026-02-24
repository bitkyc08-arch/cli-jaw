# Phase 6.9 (finness): i18n 인프라 준비

> 목표: Phase 7 (다국어 전환) 진입 전, 백엔드·레지스트리·프런트엔드·CLI·텔레그램에 산재된  
> 하드코딩 문자열을 **i18n-ready 구조로 리팩터링**한다.  
> Phase 7은 이 기반 위에서 순수 locale JSON 작성 + UI 토글 작업만 수행.

---

## 난이도: ★★★★☆ (중-상), ~5-6시간

---

## 0. 핵심 설계: 3-인터페이스 Locale 컨텍스트 전파

> ⚠️ **커맨드 엔진(`commands.js`)이 web/cli/telegram 3개 인터페이스에서 공용**이므로,
> locale 컨텍스트를 **요청 단위로 전파**해야 한다.

### 설계

```
[Web]     → Accept-Language 헤더 또는 localStorage → ctx.locale
[CLI]     → --lang 플래그 또는 settings.locale     → ctx.locale
[Telegram]→ settings.locale (서버 설정 기본값)      → ctx.locale
```

#### 구현 방향

```js
// src/i18n.js [NEW] — 서버 측 t() 함수
const locales = {};   // { ko: { ... }, en: { ... } }

// BCP47 정규화: 'en-US' → 'en', 'ko-KR' → 'ko', 'EN' → 'en'
export function normalizeLocale(raw, defaultLocale = 'ko') {
    if (!raw || typeof raw !== 'string') return defaultLocale;
    const base = raw.trim().toLowerCase().split(/[-_]/)[0];
    return locales[base] ? base : defaultLocale;
}

export function loadLocales(localeDir) {
    for (const f of fs.readdirSync(localeDir).filter(f => f.endsWith('.json') && !f.startsWith('skills-'))) {
        locales[f.replace('.json', '')] = JSON.parse(fs.readFileSync(join(localeDir, f), 'utf8'));
    }
}

export function t(key, params = {}, lang = 'ko') {
    const dict = locales[lang] || locales['ko'] || {};
    let val = dict[key] ?? key;  // fallback: 키 자체 표시
    for (const [k, v] of Object.entries(params)) {
        val = val.replaceAll(`{${k}}`, String(v));
    }
    return val;
}

// A-2.md Language 필드 → locale 코드 정규화
const LANG_NORMALIZE = {
    'korean': 'ko', '한국어': 'ko', 'ko': 'ko',
    'english': 'en', '영어': 'en', 'en': 'en',
    'japanese': 'ja', '일본어': 'ja', 'ja': 'ja',
    'chinese': 'zh', '중국어': 'zh', 'zh': 'zh',
};

export function getPromptLocale(a2Path) {
    try {
        const a2 = fs.existsSync(a2Path) ? fs.readFileSync(a2Path, 'utf8') : '';
        const match = a2.match(/Language\s*[:：]\s*(.+)/i);
        const raw = (match?.[1] || '').trim().toLowerCase();
        return LANG_NORMALIZE[raw] || 'ko';
    } catch { return 'ko'; }
}
```

#### 각 인터페이스의 ctx.locale 주입

```js
// server.js — makeWebCommandCtx(): 명시적 locale 파라미터 우선 (Accept-Language 미사용)
locale: normalizeLocale(req?.query?.locale || settings.locale, 'ko'),

// telegram.js — makeTelegramCommandCtx()
locale: settings.locale || 'ko',

// bin/commands/chat.js — makeCliCommandCtx()
locale: settings.locale || 'ko',  // settings는 /api/settings에서 fetch
```

#### 커맨드 엔진에서 사용

```js
// commands.js — handler 시그니처에 ctx.locale 활용
async function modelHandler(args, ctx) {
    const locale = ctx.locale || 'ko';
    if (!args.length) return { ok: true, text: t('cmd.model.current', { cli: activeCli, model: current }, locale) };
    // ...
}
```

### 영향 범위

| 파일 | 변경 |
|------|------|
| `src/i18n.js` | [NEW] `t()`, `loadLocales()`, `normalizeLocale()`, `getPromptLocale()` |
| `src/commands.js` | 17 handler 전부 — desc + 응답에 `t()` 사용 |
| `server.js` | `makeWebCommandCtx()`에 `locale` 추가, `/api/command` + `/api/commands`에 `Vary` + `Content-Language` 헤더, `normalizeLocale()` 사용 |
| `src/telegram.js` | `makeTelegramCommandCtx()`에 `locale` 추가, `syncTelegramCommands()`에 `language_code` 파라미터 |
| `bin/commands/chat.js` | `makeCliCommandCtx()`에 `locale` 추가, UI 문자열 |

---

## 1. Subagent Names & Role Names

### 현재 상태

```js
// server.js:74-79 — 4명 (문서/코드 기준 통일)
const DEFAULT_EMPLOYEES = [
    { name: '프런트', role: 'UI/UX 구현, CSS, 컴포넌트 개발' },
    { name: '백엔드', role: 'API, DB, 서버 로직 구현' },
    { name: '데이터', role: '데이터 파이프라인, 분석, ML' },
    { name: '문서',   role: '문서화, README, API docs' },
];

// constants.js:113-119
export const ROLE_PRESETS = [
    { value: 'frontend', label: '🎨 프런트엔드', prompt: 'UI/UX 구현, CSS, 컴포넌트 개발', ... },
    ...
];

// employees.js:22-29 — LEGACY_MAP (한국어 role → preset value)
const LEGACY_MAP = { 'React/Vue 기반 UI 컴포넌트 개발, 스타일링': 'frontend', ... };
```

### 변경 방향

```js
// server.js — name/role을 키로 보존, DB에는 영어 기본값 저장
const DEFAULT_EMPLOYEES = [
    { name: 'Frontend', role: 'frontend' },  // role은 preset value
    { name: 'Backend',  role: 'backend' },
    { name: 'Data',     role: 'data' },
    { name: 'Docs',     role: 'docs' },
];

// constants.js — label은 i18n key, prompt는 영어 (기능 식별용)
{ value: 'frontend', labelKey: 'role.frontend', label: '🎨 Frontend', prompt: 'UI/UX, CSS, components', ... },
```

### ⚠️ DB 마이그레이션

기존 DB에 한국어 role 문자열이 저장된 경우, `LEGACY_MAP`을 **확장하여 역호환** 유지:

```js
// employees.js — LEGACY_MAP 확장 (기존 한국어 role → preset value 매핑 유지)
const LEGACY_MAP = {
    // 기존 한국어 매핑 (역호환)
    'React/Vue 기반 UI 컴포넌트 개발, 스타일링': 'frontend',
    'API 서버, DB 스키마, 비즈니스 로직 구현': 'backend',
    // ... 기존 매핑 유지
    // Phase 6.9 이후 새 영어 기본값
    'UI/UX, CSS, components': 'frontend',
    'API, DB, server logic': 'backend',
};
```

> 마이그레이션 스크립트 대신 LEGACY_MAP 확장으로 무중단 전환.

### 영향 범위

- `employees.js` → `renderEmployees()` — label 표시
- `orchestrator.js` → `distributeByPhase()` — agent name 매칭
- `prompt.js` → `getSubAgentPromptV2()` — role 기반 스킬 주입
- `commands.js` → `employeeHandler()`, `skillArgumentCompletions()`

---

## 2. Skill Registry Names

### 현재 상태

```json
// registry.json — 106개 skill 전부 한국어 name/description
"weather": {
    "name": "날씨",
    "description": "wttr.in 날씨·예보 조회. API 키 불필요."
}
```

### 변경 방향 — 선택지 B (별도 locale 파일, 권장)

> 선택지 A(registry.json 내 영어 기본값)는 **현재 한국어 기본 동작을 깨뜨림**.  
> 선택지 B가 기존 코드를 건드리지 않으면서 locale 오버라이드만 추가.

```
public/locales/skills-ko.json  ← 현재 registry.json에서 추출 (기존 동작 유지)
public/locales/skills-en.json  ← 영어 번역
```

```js
// src/prompt.js — getMergedSkills() 수정
// locale 파라미터 받아서 name/description 오버라이드
export function getMergedSkills(locale = 'ko') {
    const skills = loadSkillRegistry();
    const overrides = loadSkillLocale(locale);  // skills-{locale}.json
    return skills.map(s => ({
        ...s,
        name: overrides[`${s.id}.name`] ?? s.name,
        description: overrides[`${s.id}.description`] ?? s.description,
    }));
}
```

> **registry.json 자체는 수정하지 않음** → 기존 한국어 기본 동작 보존.

### 영향 범위

- `prompt.js` → `loadSkillRegistry()`, `getMergedSkills()`
- `skills.js` → `renderSkills()` — name/description 표시
- `server.js` → `/api/skills` 엔드포인트에 locale 파라미터 추가

---

## 3. Skill Category Labels

### 현재 상태

카테고리 ID는 영어 (양호). UI 라벨이 한국어:

```html
<!-- index.html:184-192 -->
<button class="skill-filter" data-filter="all">전체</button>
<button class="skill-filter" data-filter="installed">📦 설치됨</button>
<button class="skill-filter" data-filter="productivity">📝 생산성</button>
<button class="skill-filter" data-filter="communication">📧 커뮤</button>
<button class="skill-filter" data-filter="devtools">🔧 개발</button>
<button class="skill-filter" data-filter="utility">🌐 유틸</button>
<button class="skill-filter" data-filter="smarthome">🏠 홈</button>
<button class="skill-filter" data-filter="other">📂 기타</button>
```

### 변경 방향

`data-i18n` 속성 추가 → Phase 7에서 `applyI18n()`이 치환:

```html
<button class="skill-filter" data-filter="all" data-i18n="skill.filter.all">전체</button>
```

---

## 4. Command & Fallback Names

### 현재 상태

`commands.js` 17개 명령어 모두 한국어:

```js
desc: '커맨드 목록'           // 17개 desc 전부
'알 수 없는 커맨드: /${name}'  // unknownCommand()
'❌ 설정을 불러올 수 없습니다.' // 다수 handler
'사용 가능한 커맨드'           // helpHandler()
'현재 모델(${cli}): ${current}' // modelHandler()
```

보조 함수 (인자 자동완성):

```js
skillArgumentCompletions()    → '스킬 목록', '스킬 초기화'
employeeArgumentCompletions() → '기본 5명 재생성'  // ← 실제는 4명
browserArgumentCompletions()  → '브라우저 상태', '열린 탭 목록'
fallbackArgumentCompletions() → '비활성화'
```

서버/텔레그램 에러:

```js
// server.js:346-357
'슬래시 커맨드가 아닙니다.'
'서버 오류: ${err.message}'

// telegram.js:143,179,264,434,437,452
'❌ Telegram에서 설정 변경은 지원하지 않습니다.'
'(Telegram에서 미지원)'
'📥 대기열에 추가됨 (${n}번째)'
'[📷 이미지] ${caption}'
'❌ 이미지 처리 실패: ${err.message}'
'❌ 파일 처리 실패: ${err.message}'

// telegram.js:44,63
'⏰ 시간 초과 (20분 무응답)'
'응답 없음'
```

CLI:

```js
// bin/commands/chat.js:154,173,389,696,700
'실패 → 재시도'
'파일 없음: ${fp}'
'인자 선택'
'사용자가 파일을 보냈습니다'
```

### 변경 방향

모든 문자열을 i18n key로:

```js
// commands.js — desc를 key로 저장
{ name: 'help', descKey: 'cmd.help.desc', ... }

// 표시 시 t() 호출 (getCompletionItems, handler 등)
function getDesc(cmd, locale) {
    return cmd.descKey ? t(cmd.descKey, {}, locale) : cmd.desc;
}

// employeeArgumentCompletions — 4명으로 수정
return [{ value: 'reset', label: t('cmd.employee.resetLabel', {}, locale) }];
// ko: '기본 4명 재생성', en: 'Reset to 4 defaults'
```

#### ⚠️ `/api/commands` + Telegram `setMyCommands` locale 전파

```js
// server.js — /api/commands에 locale + Vary + Content-Language
app.get('/api/commands', (req, res) => {
    const iface = String(req.query.interface || 'web');
    const locale = normalizeLocale(req.query.locale || settings.locale, 'ko');
    res.vary('Accept-Language');
    res.set('Content-Language', locale);
    res.json(COMMANDS
        .filter(c => c.interfaces.includes(iface) && !c.hidden)
        .map(c => ({
            name: c.name,
            desc: c.descKey ? t(c.descKey, {}, locale) : c.desc,
            // ...
        }))
    );
});

// telegram.js — syncTelegramCommands에 language_code 주입
function syncTelegramCommands(bot) {
    const locale = settings.locale || 'ko';
    const cmds = COMMANDS
        .filter(c => c.interfaces.includes('telegram') && ...)
        .map(c => ({
            command: c.name,
            description: toTelegramCommandDescription(
                c.descKey ? t(c.descKey, {}, locale) : c.desc
            ),
        }));
    // Telegram Bot API: language_code로 언어별 커맨드 설명 등록
    return Promise.all([
        bot.api.setMyCommands(cmds),
        bot.api.setMyCommands(cmds, { language_code: locale }),
    ]);
}
```

### 영향 범위

- `commands.js` — 17 handler + 4개 completion 함수
- `server.js` — `/api/command` 에러 2곳 + **`/api/commands` desc locale**
- `telegram.js` — 에러 메시지 6곳 + timeout 2곳 + **`syncTelegramCommands()` desc**
- `bin/commands/chat.js` — UI 문자열 5곳
- `commands-parse.test.js` — desc 문자열 체크 부분

---

## 5. Orchestrator Phase Names & Prompts — 2계층 분리

### 핵심 문제

orchestrator 프롬프트는 **LLM에 전송되는 지시문** →  
사용자 UI 언어와 **독립적으로** 제어해야 함.

### 현재 상태

```js
// orchestrator.js:12
const PHASES = { 1: '기획', 2: '기획검증', 3: '개발', 4: '디버깅', 5: '통합검증' };

// orchestrator.js:66-92
const PHASE_INSTRUCTIONS = {
    1: `[기획] 이 계획의 실현 가능성을 검증하세요. ...`,
    // ...
};

// orchestrator.js:208-270 — phasePlan 프롬프트 전체 한국어
const planPrompt = `## 작업 요청\n...`;
```

### 변경 방향

```
UI 표시 (badge, ws message)  → t('phase.1', {}, userLocale)     → '기획' / 'Planning'
Agent 프롬프트 (LLM 지시문)  → promptLocale (A-2.md Language 설정) → 항상 한국어 (현재)
```

#### A-2.md Language 파싱 (정규화 포함)

`getPromptLocale()`는 Section 0의 `src/i18n.js`에 정의됨.
`LANG_NORMALIZE` 매핑으로 `English` → `en`, `한국어` → `ko` 등 자동 정규화.
```

#### 프롬프트 locale 파일

```
src/locales/prompts-ko.json  ← 현재 하드코딩된 프롬프트 텍스트 추출
src/locales/prompts-en.json  ← 영어 번역 (향후)
```

```js
// orchestrator.js
import { t, getPromptLocale } from './i18n.js';

// UI용 (사용자 locale)
const PHASE_KEYS = { 1: 'phase.plan', 2: 'phase.verify', 3: 'phase.dev', 4: 'phase.debug', 5: 'phase.integrate' };

// Agent용 (프롬프트 locale)
function getPhaseInstruction(phase) {
    const promptLocale = getPromptLocale();
    return t(`prompt.phase.${phase}`, {}, promptLocale);
}
```

### 영향 범위

- `orchestrator.js` — PHASES, PHASE_INSTRUCTIONS, phasePlan, phaseReview
- `prompt.js` — A1_CONTENT, A2_DEFAULT, HEARTBEAT_DEFAULT, getSystemPrompt(), getSubAgentPromptV2()
- `server.js:200` — WebSocket continue intent 에러
- `employees.js:70` — phaseLabel 표시
- `ws.js:30,33,35,37,44` — 라운드/폴백 메시지

---

## 6. Frontend UI 문자열 전체 목록

### index.html 정적 텍스트 (30+개)

| 라인 | 문자열 | 키 |
|------|--------|-----|
| 65-68 | `1분`, `5분`, `10분`, `수동` | `time.1m`, `time.5m`, `time.10m`, `time.manual` |
| 88 | `파일을 여기에 드랍하세요` | `drag.drop` |
| 95 | `응답 중` | `status.responding` |
| 106 | `커맨드 목록` (aria-label) | `aria.cmdList` |
| 107 | `파일 첨부` (title) | `btn.attach` |
| 110 | `메시지 입력...` (placeholder) | `input.placeholder` |
| 184-192 | 스킬 필터 버튼 8개 | `skill.filter.*` |
| 194 | `로딩 중...` | `loading` |
| 201 | `시스템 프롬프트 편집` | `btn.editPrompt` |
| 219 | `콤마 구분 (비워두면 전체 허용)` | `tg.chatIds.placeholder` |
| 230,248,267,277,297 | `model ID 입력` (×5) | `model.placeholder` |
| 311 | `CLI 실패 시 자동 재시도 순서` | `fallback.desc` |
| 342 | `취소` | `btn.cancel` |
| 343 | `저장` | `btn.save` |
| 358 | `새 하트비트 추가` | `hb.add` |

### JS 동적 문자열 (추가분)

| 파일:라인 | 문자열 | 키 |
|-----------|--------|-----|
| `ws.js:30` | `라운드 ${n} — ${n}개 작업` | `ws.roundStart` |
| `ws.js:33` | `라운드 ${n} 완료` | `ws.roundDone` |
| `ws.js:35` | `라운드 ${n} → 다음 라운드` | `ws.roundNext` |
| `ws.js:37` | `라운드 ${n} → 재시도` | `ws.roundRetry` |
| `ws.js:44` | `${from} 실패 → ${to}로 재시도` | `ws.fallback` |
| `ui.js:15` | `멈춤 (Stop)` | `btn.stop` |
| `ui.js:88` | `You` | `msg.you` |
| `ui.js:122` | `Messages: ${n}` | `stat.messages` |
| `ui.js:136` | `No memory yet` | `mem.empty` |
| `chat.js:45` | `커맨드 실행 실패` | `chat.cmd.fail` |
| `chat.js:56` | `사용자가 파일을 보냈습니다` | `chat.file.sent` |
| `chat.js:64` | `파일 업로드 실패` | `chat.file.uploadFail` |
| `chat.js:77` | `요청 실패` | `chat.requestFail` |
| `chat.js:84` | `이전 worklog 기준으로 이어서 진행` | `chat.continue` |
| `skills.js:11` | `스킬 로드 실패` | `skill.loadFail` |
| `skills.js:29` | `활성 N개 / 전체 N개` | `skill.count` |
| `employees.js:15` | `에이전트를 추가하세요` | `emp.addPrompt` |
| `employees.js:43` | `삭제` (title) | `emp.delete` |
| `employees.js:66` | `커스텀 역할...` | `emp.customRole` |
| `employees.js:91` | `✏️ 직접 입력...` | `emp.customModel` |
| `heartbeat.js:20` | `하트비트가 없습니다` | `hb.empty` |
| `heartbeat.js:25` | `이름` (placeholder) | `hb.name` |
| `heartbeat.js:35` | `프롬프트...` (placeholder) | `hb.prompt` |
| `slash-commands.js:52` | `일치하는 커맨드가 없습니다` | `cmd.noMatch` |
| `memory.js:58` | `No memory files yet` | `mem.noFiles` |
| `main.js:103` | `모델 ID를 입력하세요` | `model.promptInput` |
| `settings.js:24` | `✏️ 직접 입력...` | `model.customOption` |
| `settings.js:169` | `동기화 중...` | `mcp.syncing` |
| `settings.js:182` | `📦 npm i -g 설치 중... (최대 2분 소요)` | `mcp.installing` |
| `settings.js:280` | `model ID 입력` (placeholder) | `model.placeholder` |
| `settings.js:386` | `(없음)` | `settings.none` |
| `settings.js:434` | `첫 실행 시 브라우저 인증` | `cli.gemini.auth` |
| `settings.js:462` | `⚠️ 설치 / 인증 필요` | `cli.authRequired` |

**총 키 수: ~170개** (index.html 30 + JS 동적 33 + commands 50 + orchestrator/prompt 30 + skill registry 212 별도)

---

## 7. Backend Language-Feature Discovery API

```js
// server.js — 새 라우트 2개

app.get('/api/i18n/languages', (_, res) => {
    const localeDir = join(__dirname, 'public', 'locales');
    if (!fs.existsSync(localeDir)) return res.json({ languages: ['ko'], default: 'ko' });
    const langs = fs.readdirSync(localeDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('skills-'))
        .map(f => f.replace('.json', ''));
    res.json({ languages: langs, default: settings.locale || 'ko' });
});

app.get('/api/i18n/:lang', (req, res) => {
    const lang = req.params.lang.replace(/[^a-z-]/gi, '');
    const filePath = join(__dirname, 'public', 'locales', `${lang}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'locale not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
});
```

---

## 8. 작업 순서

1. **`src/i18n.js` 생성** — 서버 측 `t()`, `loadLocales()`, `getPromptLocale()`
2. **Locale 디렉토리** — `public/locales/ko.json`, `en.json` 스켈레톤 + `skills-ko.json`
3. **Commands 리팩터링** — desc/handler 응답에 `t()` 적용
4. **상수 리팩터링** — `ROLE_PRESETS`, `DEFAULT_EMPLOYEES`, `LEGACY_MAP` 확장
5. **Orchestrator 2계층** — UI label vs Agent prompt 분리
6. **3-인터페이스 ctx.locale** — web/cli/telegram CommandCtx에 locale 주입
7. **Telegram/CLI 에러 메시지** — `t()` 치환
8. **Backend API** — `/api/i18n/languages`, `/api/i18n/:lang`
9. **settings에 locale 필드** — `config.js`에 기본값 `'ko'` 추가
10. **테스트 업데이트** — `commands-parse.test.js` desc 문자열 → key 기반

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 서버 측 `t()` | `src/i18n.js` 모듈 동작 |
| `normalizeLocale()` | BCP47 정규화 (`en-US` → `en`) |
| 3-인터페이스 locale | web/cli/telegram 모두 ctx.locale 전파 |
| HTTP 헤더 | Locale 응답에 `Vary: Accept-Language` + `Content-Language` |
| 프롬프트 분리 | UI 언어 ≠ Agent 프롬프트 언어 (A-2 Language 기반) |
| 역호환 | 기존 한국어 동작 보존 (LEGACY_MAP 확장, registry.json 미수정) |
| DB 무중단 | 기존 한국어 role → 새 preset value 매핑 유지 |
| API | `/api/i18n/languages` → `["ko", "en"]` |
| Telegram | `setMyCommands` `language_code` 파라미터 적용 |
| 키 완성 | ~170개 UI 키 + 212개 skill 키 locale JSON에 존재 |
| 테스트 | `npm test` 115개 전체 통과 (i18n 23개 포함) |
| 직원 수 정확 | 문서/코드 모두 4명 기준 통일 |

---

## Phase 6.9 → 7 순서

Phase 6.9가 완료되면 Phase 7은 **순수 프런트엔드 작업**으로 축소:

- `js/features/i18n.js` — 프런트 `t()`, `applyI18n()`, `setLang()`
- `ko.json`, `en.json` 값 채우기
- `data-i18n` 속성 + 언어 토글 UI
- `main.js` bootstrap
