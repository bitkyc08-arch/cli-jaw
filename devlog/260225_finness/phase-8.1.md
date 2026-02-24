# Phase 8.1: 보안 입력 검증 설계 (Path Guard / Decode / ID Whitelist)

> 이 문서는 Phase 8의 P0(공격면 차단) 설계를 다룬다.

---

## 왜 해야 하는가

### 현재 취약 코드 (실제 server.js 발췌)

**1) memory-files — path traversal**

```js
// server.js L480-483
app.get('/api/memory-files/:filename', (req, res) => {
    const fp = join(getMemoryDir(), req.params.filename);  // ← 검증 없음
    if (!fp.endsWith('.md') || !fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    res.json({ name: req.params.filename, content: fs.readFileSync(fp, 'utf8') });
});
```

`req.params.filename`이 `../../../etc/passwd`일 때 `join()`은 base 밖으로 탈출.
`.endsWith('.md')` 검사도 `../secret.md`로 우회 가능.

**2) skills — id injection**

```js
// server.js L660-676
app.post('/api/skills/enable', (req, res) => {
    const { id } = req.body;  // ← 아무 문자열이나 가능
    if (!id) return res.status(400).json({ error: 'id required' });
    const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');  // ← id에 ../ 포함 가능
    const dstDir = join(SKILLS_DIR, id);
    // ...
    for (const f of fs.readdirSync(refDir)) {
        fs.copyFileSync(join(refDir, f), join(dstDir, f));  // ← 임의 경로 복사
    }
});
```

`id = "../../.ssh"` → 홈 디렉토리 `.ssh` 폴더를 skills로 복사 시도.

**3) upload — filename header abuse**

```js
// server.js L497-501
app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const rawHeader = req.headers['x-filename'] || 'upload.bin';
    const filename = decodeURIComponent(rawHeader);  // ← malformed % 일 때 throw 가능
    const filePath = saveUpload(req.body, filename);  // ← 경로 조작 가능
    res.json({ path: filePath, filename: basename(filePath) });
});
```

`x-filename: %E0%A4%A` (불완전 percent-encoding) → `decodeURIComponent` throw → 500 에러.
`x-filename: ../../evil.sh` → 업로드 디렉토리 탈출.

**4) claw-memory — arbitrary file read/write**

```js
// server.js L717-728
app.get('/api/claw-memory/read', (req, res) => {
    try {
        const content = memory.read(req.query.file, { lines: req.query.lines });  // ← file 검증 없음
        res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
```

`?file=../../.env` → 환경변수 파일 읽기 시도.

---

## 설계: 3개 guard 유틸

### `src/security/path-guards.js`

```js
import path from 'node:path';

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertSkillId(id) {
  const v = String(id || '').trim();
  if (!SKILL_ID_RE.test(v)) throw badRequest('invalid_skill_id');
  if (v.includes('..') || v.includes('/') || v.includes('\\')) throw badRequest('path_segment_denied');
  return v;
}

export function assertFilename(filename, { allowExt = ['.md'] } = {}) {
  const v = String(filename || '').trim();
  if (!v || v.length > 200) throw badRequest('invalid_filename');
  if (!FILE_NAME_RE.test(v)) throw badRequest('invalid_filename_chars');
  const ext = path.extname(v).toLowerCase();
  if (allowExt.length && !allowExt.includes(ext)) throw badRequest('invalid_extension');
  return v;
}

export function safeResolveUnder(baseDir, unsafeName) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, unsafeName);
  const pref = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(pref)) throw forbidden('path_escape');
  return resolved;
}

function badRequest(code) { const e = new Error(code); e.statusCode = 400; return e; }
function forbidden(code) { const e = new Error(code); e.statusCode = 403; return e; }
```

### `src/security/decode.js`

```js
export function decodeFilenameSafe(rawHeader) {
  const raw = String(rawHeader || 'upload.bin');
  if (raw.length > 200) throw Object.assign(new Error('filename_too_long'), { statusCode: 400 });
  try {
    return decodeURIComponent(raw);
  } catch {
    throw Object.assign(new Error('invalid_percent_encoding'), { statusCode: 400 });
  }
}
```

---

## 충돌 분석

| 대상 파일 | 변경 유형 | 충돌 위험 |
|---|---|---|
| `src/security/path-guards.js` | **NEW** | 없음 |
| `src/security/decode.js` | **NEW** | 없음 |
| `server.js` L480-501 (memory-files) | MODIFY | 낮음 — 라우트 내부만 변경, 시그니처 유지 |
| `server.js` L660-696 (skills) | MODIFY | 낮음 — 같은 구조 |
| `server.js` L497-501 (upload) | MODIFY | 낮음 |
| `server.js` L712-739 (claw-memory) | MODIFY | 낮음 |

**Phase 6~7(프런트)과 충돌:** 없음 — 프런트 CSS/JS 파일과 무관.
**Phase 8.3(라우트 분리)와 충돌:** 8.1을 먼저 적용 → 8.3에서 guard가 적용된 라우트를 그대로 이동.

---

## 테스트 계획

### 파일: `tests/unit/path-guards.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkillId, assertFilename, safeResolveUnder } from '../../src/security/path-guards.js';

// ── assertSkillId ──
test('SI-001: valid id "dev"', () => assert.equal(assertSkillId('dev'), 'dev'));
test('SI-002: valid id "dev-backend"', () => assert.equal(assertSkillId('dev-backend'), 'dev-backend'));
test('SI-003: rejects "../x"', () => assert.throws(() => assertSkillId('../x'), { message: /invalid/ }));
test('SI-004: rejects "x/y"', () => assert.throws(() => assertSkillId('x/y'), { message: /invalid|path/ }));
test('SI-005: rejects empty', () => assert.throws(() => assertSkillId(''), { message: /invalid/ }));
test('SI-006: rejects uppercase', () => assert.throws(() => assertSkillId('Dev'), { message: /invalid/ }));

// ── assertFilename ──
test('FN-001: valid "notes.md"', () => assert.equal(assertFilename('notes.md'), 'notes.md'));
test('FN-002: rejects "../notes.md"', () => assert.throws(() => assertFilename('../notes.md')));
test('FN-003: rejects ".hidden.md"', () => assert.throws(() => assertFilename('.hidden.md')));
test('FN-004: rejects "note.txt" when allowExt=[.md]', () => assert.throws(() => assertFilename('note.txt')));
test('FN-005: accepts "image.png" with allowExt', () => {
  assert.equal(assertFilename('image.png', { allowExt: ['.png'] }), 'image.png');
});

// ── safeResolveUnder ──
test('SR-001: normal', () => {
  const r = safeResolveUnder('/tmp/mem', 'daily.md');
  assert.ok(r.startsWith('/tmp/mem/'));
});
test('SR-002: blocks traversal', () => {
  assert.throws(() => safeResolveUnder('/tmp/mem', '../etc/passwd'));
});
test('SR-003: blocks absolute', () => {
  assert.throws(() => safeResolveUnder('/tmp/mem', '/etc/passwd'));
});
```

### 파일: `tests/unit/decode.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFilenameSafe } from '../../src/security/decode.js';

test('DC-001: normal filename', () => assert.equal(decodeFilenameSafe('hello.png'), 'hello.png'));
test('DC-002: encoded korean', () => assert.ok(decodeFilenameSafe('%ED%85%8C%EC%8A%A4%ED%8A%B8.md').includes('테스트')));
test('DC-003: malformed % throws', () => assert.throws(() => decodeFilenameSafe('%E0%A4%A')));
test('DC-004: too long throws', () => assert.throws(() => decodeFilenameSafe('a'.repeat(300))));
test('DC-005: null/undefined defaults', () => assert.equal(decodeFilenameSafe(null), 'upload.bin'));
```

### 실행

```bash
node --test tests/unit/path-guards.test.js tests/unit/decode.test.js
```

---

## 완료 기준

- [ ] `path-guards.js` 단위 테스트 11/11 통과
- [ ] `decode.js` 단위 테스트 5/5 통과
- [ ] 고위험 라우트 4곳에 guard 적용
- [ ] 기존 `npm test` 통과 (회귀 없음)
