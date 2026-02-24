# Phase 9.1: 보안 가드 구현 + 테스트 (WS1 실행)

> Phase 8.1 설계를 실제 코드로 전환한다.

---

## 왜 해야 하는가

Phase 8.1에서 식별한 4개 취약 라우트(`memory-files`, `skills`, `upload`, `claw-memory`)는 현재 **입력 검증 없이 파일시스템 접근**을 허용한다.

```js
// 현재: server.js L480 — 검증 없는 파일 읽기
const fp = join(getMemoryDir(), req.params.filename);
// 공격: ?filename=../../../.env → 환경변수 파일 유출
```

**Phase 9.1은 기능 추가가 아니라 공격면 차단 작업이다.**

---

## 구현 순서

### Step 1: 유틸 파일 생성

```bash
mkdir -p src/security
```

#### `src/security/path-guards.js` — Phase 8.1 설계 그대로

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

#### `src/security/decode.js`

```js
export function decodeFilenameSafe(rawHeader) {
  const raw = String(rawHeader || 'upload.bin');
  if (raw.length > 200) throw Object.assign(new Error('filename_too_long'), { statusCode: 400 });
  try { return decodeURIComponent(raw); }
  catch { throw Object.assign(new Error('invalid_percent_encoding'), { statusCode: 400 }); }
}
```

### Step 2: server.js 라우트 패치 (4곳)

#### memory-files (L480-489)

```diff
+import { assertFilename, safeResolveUnder } from './src/security/path-guards.js';
+import { decodeFilenameSafe } from './src/security/decode.js';

 app.get('/api/memory-files/:filename', (req, res) => {
-    const fp = join(getMemoryDir(), req.params.filename);
-    if (!fp.endsWith('.md') || !fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
-    res.json({ name: req.params.filename, content: fs.readFileSync(fp, 'utf8') });
+    try {
+        const base = getMemoryDir();
+        const filename = assertFilename(req.params.filename, { allowExt: ['.md'] });
+        const fp = safeResolveUnder(base, filename);
+        if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not_found' });
+        res.json({ name: filename, content: fs.readFileSync(fp, 'utf8') });
+    } catch (e) {
+        res.status(e.statusCode || 500).json({ error: e.message });
+    }
 });

 app.delete('/api/memory-files/:filename', (req, res) => {
-    const fp = join(getMemoryDir(), req.params.filename);
-    if (fp.endsWith('.md') && fs.existsSync(fp)) fs.unlinkSync(fp);
+    try {
+        const base = getMemoryDir();
+        const filename = assertFilename(req.params.filename, { allowExt: ['.md'] });
+        const fp = safeResolveUnder(base, filename);
+        if (fs.existsSync(fp)) fs.unlinkSync(fp);
+    } catch (e) {
+        return res.status(e.statusCode || 500).json({ error: e.message });
+    }
     res.json({ ok: true });
 });
```

#### skills (L660-696)

```diff
 app.post('/api/skills/enable', (req, res) => {
-    const { id } = req.body;
-    if (!id) return res.status(400).json({ error: 'id required' });
-    const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
+    try {
+        const id = assertSkillId(req.body?.id);
+        const refPath = join(SKILLS_REF_DIR, id, 'SKILL.md');
         // ... 나머지 동일
+    } catch (e) {
+        res.status(e.statusCode || 500).json({ error: e.message });
+    }
 });
```

#### upload (L497-501)

```diff
 app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
-    const rawHeader = req.headers['x-filename'] || 'upload.bin';
-    const filename = decodeURIComponent(rawHeader);
+    try {
+        const decoded = decodeFilenameSafe(req.headers['x-filename']);
+        const filename = assertFilename(decoded, {
+            allowExt: ['.png','.jpg','.jpeg','.webp','.gif','.pdf','.txt','.md','.bin']
+        });
         const filePath = saveUpload(req.body, filename);
         res.json({ path: filePath, filename: basename(filePath) });
+    } catch (e) {
+        res.status(e.statusCode || 500).json({ error: e.message });
+    }
 });
```

#### claw-memory (L717-739)

```diff
 app.get('/api/claw-memory/read', (req, res) => {
     try {
+        const file = String(req.query.file || '').trim();
+        if (!file || file.includes('..') || file.startsWith('/')) {
+            return res.status(400).json({ error: 'invalid_file_param' });
+        }
         const content = memory.read(file, { lines: req.query.lines });
         res.json({ content });
     } catch (e) { res.status(500).json({ error: e.message }); }
 });
```

### Step 3: 테스트 작성 + 실행

Phase 8.1의 테스트 계획 그대로:

```bash
# 테스트 파일 생성
# tests/unit/path-guards.test.js (11 케이스)
# tests/unit/decode.test.js (5 케이스)

node --test tests/unit/path-guards.test.js tests/unit/decode.test.js
npm test  # 기존 회귀 확인
```

---

## 충돌 분석

| 대상 | 변경 | Phase 9.2~9.5와 충돌 |
|---|---|---|
| `src/security/*` | NEW | 없음 |
| `server.js` L480-501 | 라우트 내부 수정 | 9.3(라우트 분리) 시 guard 코드가 함께 이동 — **순서: 9.1 → 9.3** |
| `server.js` L660-696 | 라우트 내부 수정 | 동일 |
| `server.js` L717-739 | 라우트 내부 수정 | 동일 |
| `tests/unit/path-guards.test.js` | NEW | 없음 |

---

## 검증 시나리오

| ID | 요청 | 기대 | 유형 |
|---|---|---|---|
| SEC-001 | `GET /api/memory-files/notes.md` | 200 + 내용 | 정상 |
| SEC-002 | `GET /api/memory-files/../.env` | 400 | 보안 |
| SEC-003 | `GET /api/memory-files/..%2f.env` | 400 | 보안 |
| SEC-004 | `POST /api/skills/enable {"id":"dev"}` | 200 | 정상 |
| SEC-005 | `POST /api/skills/enable {"id":"../x"}` | 400 | 보안 |
| SEC-006 | `POST /api/upload` (x-filename: `%E0%A4%A`) | 400 | 보안 |
| SEC-007 | `POST /api/upload` (x-filename: `test.png`) | 200 | 정상 |
| SEC-008 | `GET /api/claw-memory/read?file=../../.env` | 400 | 보안 |

---

## 완료 기준

- [ ] `src/security/path-guards.js` + `decode.js` 생성
- [ ] 라우트 4곳에 guard 적용
- [ ] 단위 테스트 16/16 통과
- [ ] SEC-001~008 시나리오 확인
- [ ] `npm test` 통과
