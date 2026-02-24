# Phase 10: 비텍스트 미디어 인풋

## 아키텍처

```
[입력 경로]                      [처리]                    [에이전트 접근]
Telegram photo   ─┐
Telegram document ─┤→ saveUpload() → ~/.cli-claw/uploads/  → 프롬프트 주입
Web UI 📎/드랍   ─┤    (lib/upload.js)    {ts}_{name}.{ext}    "[파일: {path}]"
CLI /file <path>  ─┘                                        → CLI Agent Read 도구
```

## 핵심 설계: 파일 저장 + 경로 주입 패턴

JSON base64 전송이나 CLI별 이미지 인자(`--image` 등)를 쓰지 않고, **모든 비텍스트 입력을 로컬 파일로 저장 → 절대 경로를 프롬프트에 텍스트로 삽입** 하는 단일 패턴.

**이유**:
- CLI별 이미지 처리 방식이 전부 다름 (Claude: Read tool, Codex: `--image`, Gemini: 미지원)
- 파일 경로를 프롬프트에 넣으면 **어떤 CLI든** Read/파일 접근 도구로 읽을 수 있음
- base64 인코딩은 stdin NDJSON 크기 제한에 걸림
- 추가 의존성 0개 (express.raw + native https만 사용)

## 파일 구조

```
lib/
└── upload.js          ← 독립 모듈 (첫 모듈 분리)
      ├── saveUpload(uploadsDir, buffer, originalName) → filePath
      ├── buildMediaPrompt(filePath, caption) → promptString  
      └── downloadTelegramFile(fileId, token) → {buffer, ext, originalName}
```

## 구현 상세

### 10.1 `lib/upload.js` — 독립 모듈

server.js에서 분리한 첫 모듈. 의존성: `fs`, `https`, `path` (순수 I/O).

```js
// server.js에서의 사용
import { saveUpload as _saveUpload, buildMediaPrompt, downloadTelegramFile } from './lib/upload.js';
const saveUpload = (buffer, name) => _saveUpload(UPLOADS_DIR, buffer, name);
```

**saveUpload**: `{timestamp}_{sanitized_name}.{ext}` 형식으로 저장. 특수문자 제거.
**buildMediaPrompt**: `[사용자가 파일을 보냈습니다: {path}]\n이 파일을 Read 도구로 읽고 분석해주세요.`
**downloadTelegramFile**: Telegram `getFile` API → IPv4 https.get → Buffer 반환.

### 10.2 Telegram 핸들러 리팩토링

기존 `bot.on('message:text')` 핸들러의 typing + orchestrate + reply 로직을 `tgOrchestrate()` 공통 함수로 추출:

```js
async function tgOrchestrate(ctx, prompt, displayMsg) {
    telegramActiveChatIds.add(ctx.chat.id);
    insertMessage.run('user', displayMsg, 'telegram', '');
    broadcast('new_message', { role: 'user', content: displayMsg, source: 'telegram' });
    // typing + orchestrateAndCollect + HTML reply (기존 패턴)
}

bot.on('message:text', async (ctx) => {
    await tgOrchestrate(ctx, text, text);
});

bot.on('message:photo', async (ctx) => {
    const { buffer, ext } = await downloadTelegramFile(largest.file_id, token);
    const filePath = saveUpload(buffer, `photo${ext}`);
    await tgOrchestrate(ctx, buildMediaPrompt(filePath, caption), `[📷 이미지] ${caption}`);
});

bot.on('message:document', async (ctx) => {
    const { buffer } = await downloadTelegramFile(doc.file_id, token);
    const filePath = saveUpload(buffer, doc.file_name);
    await tgOrchestrate(ctx, buildMediaPrompt(filePath, caption), `[📎 ${doc.file_name}] ${caption}`);
});
```

### 10.3 `POST /api/upload` — Web UI 엔드포인트

```js
app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const filename = req.headers['x-filename'] || 'upload.bin';
    const filePath = saveUpload(req.body, filename);
    res.json({ path: filePath, filename: basename(filePath) });
});
```

- `express.raw()` 사용 → multer 등 추가 의존성 불필요
- 파일명은 `X-Filename` 헤더로 전달
- 20MB 제한

### 10.4 Web UI — 📎 버튼 + 드래그 & 드랍

**HTML 구조**:
```html
<div class="chat-area" style="position:relative">
    <div class="drag-overlay" id="dragOverlay">📎 파일을 여기에 드랍하세요</div>
    <!-- ... chat messages ... -->
    <div class="file-preview" id="filePreview">
        <span id="filePreviewName"></span>
        <img id="filePreviewImg">
        <button class="remove" onclick="clearAttachedFile()">✕</button>
    </div>
    <div class="chat-input-area">
        <button class="btn-attach">📎</button>
        <input type="file" id="fileInput" hidden>
        <textarea ...></textarea>
        <button class="btn-send">➤</button>
    </div>
</div>
```

**JS 흐름**:
1. 📎 클릭 또는 드래그 드랍 → `attachFile(file)` → 프리뷰 바 표시
2. 전송 시 → `uploadFile(file)` (POST /api/upload) → 경로 반환 → `buildMediaPrompt` → POST /api/message
3. 이미지면 프리뷰 썸네일 표시, 비이미지면 파일명만

**드래그 & 드랍**:
- `dragCounter`로 중첩 자식 요소 drag 이벤트 처리
- 오버레이: dashed border + 반투명 배경

### 10.5 CLI `/file` — 로컬 경로 참조

```
/file ./screenshot.png 이 UI를 분석해줘
```

- 파일 존재 확인 (`fs.existsSync`) → 없으면 에러 출력
- `path.resolve()`로 절대 경로 변환
- simple 모드 + default (raw stdin) 모드 양쪽에 구현

## 체크리스트

- [x] 10.1 `lib/upload.js` 독립 모듈
- [x] 10.2 server.js import + UPLOADS_DIR 바인딩
- [x] 10.3 `tgOrchestrate()` 공통 함수 추출
- [x] 10.4 Telegram `message:photo` 핸들러
- [x] 10.5 Telegram `message:document` 핸들러
- [x] 10.6 `POST /api/upload` 엔드포인트
- [x] 10.7 Web UI 📎 버튼 + hidden `<input type="file">`
- [x] 10.8 Web UI 드래그 & 드랍 오버레이
- [x] 10.9 Web UI 파일 프리뷰 바 + clearAttachedFile
- [x] 10.10 CLI `/file` 명령 (simple + default)

## 변경 파일

| 파일                   | 변경                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `lib/upload.js`        | **[NEW]** 독립 모듈 3개 함수                                                |
| `server.js`            | import 추가, tgOrchestrate 리팩토링, photo/doc 핸들러, POST /api/upload     |
| `public/index.html`    | CSS(attach/drag/preview) + HTML(📎/overlay/preview) + JS(upload/drag/attach) |
| `bin/commands/chat.js` | fs/path import + /file 명령 (simple + default 모드)                         |
