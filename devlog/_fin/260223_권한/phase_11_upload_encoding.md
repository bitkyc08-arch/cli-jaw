# (fin) Phase 11 — 파일 업로드 인코딩 버그 수정

## 개요

맥 스크린샷 업로드 시 `fetch()` 오류 수정.

**증상**: Web UI에서 맥 스크린샷(한글 파일명) 드래그앤드롭 시 다음 오류 발생:

```
Failed to execute 'fetch' on 'Window':
Failed to read the 'headers' property from 'RequestInit':
String contains non ISO-8859-1 code point.
```

**원인**: 맥 기본 스크린샷 파일명 `스크린샷 2026-02-23 오후 11.55.03.png`에 한글이 포함됨. HTTP 헤더는 ISO-8859-1만 허용하므로, `X-Filename` 헤더에 한글이 직접 들어가면 브라우저가 `fetch()` 호출 자체를 거부.

> 출처: [Fetch Standard — Headers class](https://fetch.spec.whatwg.org/#concept-header-value)
> HTTP 헤더 값은 0x00-0xFF 범위의 byte sequence만 허용. 한글은 UTF-8 multi-byte이므로 범위 초과.

---

## 수정

### [MODIFY] `public/js/features/chat.js`

클라이언트에서 파일명을 `encodeURIComponent()`로 percent-encoding:

```diff
 async function uploadFile(file) {
     const res = await fetch('/api/upload', {
         method: 'POST',
-        headers: { 'X-Filename': file.name },
+        headers: { 'X-Filename': encodeURIComponent(file.name) },
         body: file,
     });
```

### [MODIFY] `server.js`

서버에서 `decodeURIComponent()`로 원래 파일명 복원:

```diff
 app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
-    const filename = req.headers['x-filename'] || 'upload.bin';
+    const rawHeader = req.headers['x-filename'] || 'upload.bin';
+    const filename = decodeURIComponent(rawHeader);
     const filePath = saveUpload(req.body, filename);
```

---

## 영향 범위

- `saveUpload()` (`lib/upload.js`)의 `safeName` 생성 로직은 이미 `replace(/[^a-zA-Z0-9_-]/g, '')` 처리하므로, 디코딩된 한글 문자는 자동으로 제거됨
- 실제 저장되는 파일명: `1740319503000_.png` (타임스탬프 + 확장자만 유지)
- Telegram 업로드 경로(`downloadTelegramFile`)는 영향 없음 (서버 간 통신이라 헤더 사용 안 함)

---

## 체크리스트

- [x] `public/js/features/chat.js` — `encodeURIComponent(file.name)`  
- [x] `server.js` — `decodeURIComponent(rawHeader)`
- [x] 한글 파일명 스크린샷 업로드 테스트
