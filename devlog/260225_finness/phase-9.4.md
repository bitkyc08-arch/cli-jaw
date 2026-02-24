# Phase 9.4: 테스트/커버리지 확장 (WS4)

> Phase 8 감사에서 식별된 미테스트 모듈의 테스트 작성.

---

## 왜 해야 하는가

- `agent.js`, `orchestrator.js` 핵심 분기(인자 빌드/triage/JSON 파싱)는 직접 단위 테스트가 부족함
- subtask 파싱/인자 빌드/설정 마이그레이션 버그 시 전체 시스템 불통
- 기존 테스트만으로는 핵심 경로 회귀 감지가 부족함

---

## 신규 테스트 4개

### 1. `tests/unit/orchestrator-parsing.test.js` (실제 export 파싱 검증)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtasks, parseDirectAnswer, stripSubtaskJSON } from '../../src/orchestrator.js';

test('ORP-001: fenced json subtasks parse', () => {
  const input = 'x\n```json\n{"subtasks":[{"agent":"백엔드","task":"a"}]}\n```';
  const st = parseSubtasks(input);
  assert.equal(st[0].agent, '백엔드');
});

test('ORP-002: malformed json returns null', () => {
  assert.equal(parseSubtasks('```json\n{broken\n```'), null);
});

test('ORP-003: direct_answer only path', () => {
  const input = '```json\n{"direct_answer":"ok","subtasks":[]}\n```';
  assert.equal(parseDirectAnswer(input), 'ok');
});

test('ORP-004: stripSubtaskJSON removes json block', () => {
  const s = stripSubtaskJSON('요약\n```json\n{"subtasks":[]}\n```');
  assert.equal(s, '요약');
});
```

### 2. `tests/unit/orchestrator-triage.test.js` (분기 규칙 검증)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isContinueIntent, needsOrchestration } from '../../src/orchestrator.js';

test('ORT-001: continue intent positive', () => {
  assert.equal(isContinueIntent('continue'), true);
  assert.equal(isContinueIntent('이어서 해줘'), true);
});

test('ORT-002: continue intent negative', () => {
  assert.equal(isContinueIntent('계획 검토해줘'), false);
});

test('ORT-003: complex coding request needs orchestration', () => {
  const msg = 'server.js 라우트 분리하고 tests 추가하고 API 회귀 확인해줘';
  assert.equal(needsOrchestration(msg), true);
});

test('ORT-004: short casual message bypasses orchestration', () => {
  assert.equal(needsOrchestration('안녕'), false);
});
```

### 3. `tests/unit/agent-args.test.js` (실제 buildArgs/buildResumeArgs 검증)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildResumeArgs } from '../../src/agent.js';

test('AG-001: claude default excludes --model', () => {
  const args = buildArgs('claude', 'default', '', 'hi', 'sys', 'safe');
  assert.ok(!args.includes('--model'));
});

test('AG-002: codex auto includes bypass flag', () => {
  const args = buildArgs('codex', 'o3', 'high', 'hi', '', 'auto');
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('AG-003: gemini includes prompt payload', () => {
  const args = buildArgs('gemini', 'gemini-2.5-pro', '', 'hello', '', 'safe');
  assert.ok(args.includes('hello'));
});

test('AG-004: resume args include session id', () => {
  const args = buildResumeArgs('claude', 'default', '', 'sess-1', 'next', 'safe');
  assert.ok(args.includes('sess-1'));
});
```

### 4. `tests/unit/settings-merge.test.js` (settings patch 병합 규칙 검증)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettingsPatch } from '../../src/settings-merge.js';

test('SM-001: perCli deep merge preserves existing effort', () => {
  const current = { perCli: { copilot: { model: 'a', effort: 'high' } } };
  const next = mergeSettingsPatch(current, { perCli: { copilot: { model: 'b' } } });
  assert.equal(next.perCli.copilot.effort, 'high');
});

test('SM-002: activeOverrides deep merge preserves sibling keys', () => {
  const current = { activeOverrides: { codex: { model: 'o3', effort: 'medium' } } };
  const next = mergeSettingsPatch(current, { activeOverrides: { codex: { model: 'o4' } } });
  assert.equal(next.activeOverrides.codex.effort, 'medium');
});
```

---

## 커버리지 게이트

```bash
node --test --experimental-test-coverage \
  --test-coverage-lines=70 --test-coverage-functions=70 \
  tests/*.test.js tests/**/*.test.js
```

`package.json`에 추가:
```json
{ "scripts": { "test:coverage": "node --test --experimental-test-coverage --test-coverage-lines=70 tests/*.test.js tests/**/*.test.js" } }
```

---

## 충돌 분석

| 대상 | 충돌 |
|---|---|
| `tests/unit/*` (4개 NEW) | 없음 |
| `src/settings-merge.js` | **NEW** (server.js의 병합 로직 추출) |
| `server.js` | `applySettingsPatch`가 `mergeSettingsPatch` 사용하도록 경량 수정 |
| Phase 9.3 | 9.3 완료 후 import 경로 안정 → **순서: 9.3 → 9.4** |
| **병렬 가능**: 9.1/9.2와 동시 작업 OK |

---

## 완료 기준

- [ ] 테스트 4개 파일, 12+ 케이스 추가
- [ ] `npm test` 전체 통과
- [ ] coverage lines 70% 이상
