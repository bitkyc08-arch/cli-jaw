# Phase 1 (P1): 정합성(Registry/문서) 구현 계획 (1~2일)

## 우선순위 재배치 메모
- `symlink 보호`는 데이터 유실 리스크 때문에 P1이 아니라 P0로 상향하는 것이 맞음
- 본 문서는 P1 범위를 `CLI/모델 단일 소스 + 문서/코드 정합성`으로 한정
- 최소 회귀 테스트 2개는 별도 `phase-1.1.md`로 분리

## 목표
- CLI/모델 정의 단일 소스화
- 프론트/백엔드 모델 목록 드리프트 제거
- Copilot 문서-코드 상태 불일치 제거

## 구현 결과 (2026-02-24)
- [x] `src/cli-registry.js` 신설
- [x] `src/config.js`, `src/commands.js`, `server.js`를 registry 기반으로 전환
- [x] `public/js/constants.js`에서 `/api/cli-registry` 기반 동적 로딩 + fallback(`FALLBACK_CLI_REGISTRY`) 적용
- [x] `public/js/features/settings.js`, `public/js/features/employees.js`, `public/js/main.js` 하드코딩 CLI 배열 제거
- [x] `scripts/check-copilot-gap.js`, `devlog/260225_copilot-cli-integration/status.md` 추가

## 범위
- `src/cli-registry.js`
- `src/config.js`, `src/commands.js`, `server.js`
- `public/js/constants.js`, `public/js/features/settings.js`, `public/js/features/employees.js`, `public/js/main.js`, `public/index.html`
- `scripts/check-copilot-gap.js`
- `devlog/260225_copilot-cli-integration/*`

---

## 1-1. CLI/모델 단일 소스 (`cli-registry`)

### 문제
- CLI/모델 목록이 파일별 하드코딩으로 분산되어 drift 발생

### 설계
- 백엔드 단일 레지스트리(`src/cli-registry.js`)를 source of truth로 사용
- 프론트는 `/api/cli-registry`로 동기화하고, 서버 미기동 시 fallback 레지스트리 사용

### 핵심 구현
```js
// src/commands.js
import { CLI_KEYS, buildModelChoicesByCli } from './cli-registry.js';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();
```

```js
// server.js
import { CLI_REGISTRY } from './src/cli-registry.js';
app.get('/api/cli-registry', (_, res) => res.json(CLI_REGISTRY));
```

```js
// public/js/constants.js
export let MODEL_MAP = toModelMap(CLI_REGISTRY);
export async function loadCliRegistry() {
  const data = await (await fetch('/api/cli-registry')).json();
  applyRegistry(data);
}
```

### 완료 기준
- 프론트/백엔드 모델 목록 diff 0건
- 신규 CLI 추가 시 수정 지점이 registry 중심으로 제한됨

---

## 1-2. Copilot 문서-코드 갭 정리

### 문제
- 문서 계획과 실제 구현 상태가 분리되면 후속 작업 우선순위 판단이 흔들림

### 설계
- 상태 매트릭스(`status.md`)로 계획/코드/근거 파일 동시 관리
- 갭 체크 스크립트(`check-copilot-gap.js`)를 npm script로 고정

### 핵심 구현
```json
// package.json
{
  "scripts": {
    "check:copilot-gap": "node scripts/check-copilot-gap.js"
  }
}
```

### 완료 기준
- 문서 상태와 코드 상태 불일치 항목 0건
- `npm run check:copilot-gap`로 즉시 검증 가능

---

## 검증 명령
```bash
cd ~/Documents/BlogProject/cli-claw
node --check src/cli-registry.js
node --check src/config.js
node --check src/commands.js
node --check public/js/constants.js
node --check public/js/features/settings.js
node --check public/js/features/employees.js
node --check public/js/main.js
npm run check:copilot-gap
```

---

## 커밋
- `af75bd1` `[agent] phase1: symlink safety + cli registry single source`

## 참고
- symlink 보호 구현/근거는 `phase-0.md`로 이동
- 최소 회귀 테스트 계획은 `phase-1.1.md` 참조
