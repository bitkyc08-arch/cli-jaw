# Phase 1 (P1): 안전성/정합성 구현 계획 (1~2일)

## 목표
- 사용자 파일 유실 없이 symlink 구성
- CLI/모델 정의 단일 소스화
- Copilot 문서-코드 상태 불일치 제거

## 재검토 근거 (Context7 + Web)
- Node fs API:
  - `lstatSync`는 symlink 대상이 아니라 링크 자체를 검사함.
  - `readlinkSync`는 symlink target 문자열을 읽음.
  - `rmSync(path, { recursive: true })`는 디렉터리 전체 삭제 동작이므로 충돌 경로에 직접 적용 시 위험.
  - `renameSync`로 백업 이동 후 symlink 교체가 가능.
- 출처
  - https://nodejs.org/api/fs.html
  - Context7 source: https://github.com/nodejs/node/blob/main/doc/api/fs.md

## 범위
- `lib/mcp-sync.js`
- `bin/postinstall.js`
- `src/config.js`, `src/commands.js`
- `public/index.html`, `public/js/constants.js`, `public/js/features/settings.js`, `public/js/features/employees.js`
- `server.js`
- `devlog/260225_copilot-cli-integration/*`

---

## 1-1. symlink 보호 모드 (delete-first 제거)

### 문제
- 현재 `ensureSymlinkForce()`는 실디렉토리면 즉시 삭제
- 사용자 기존 `~/.claude/skills` 보유 시 데이터 손실 가능

### 상세 이유 (왜 지금 필요한가)
- 현재 코드(`lib/mcp-sync.js`)는 충돌 시 `fs.rmSync(linkPath, { recursive: true })`를 실행함.
- `recursive` 삭제는 되돌리기 어려워, 사용자의 실데이터를 훼손할 수 있음.
- Node API 상 `lstatSync + readlinkSync`로 "정상 symlink인지"를 먼저 판정한 뒤 처리하는 것이 안전함.

### 설계
- conflict 발견 시 기본 동작은 backup
- 백업 경로: `~/.cli-claw/backups/skills-conflicts/<timestamp>/...`
- postinstall/reset에서 결과를 로그/응답으로 노출

### 코드 스니펫 (mcp-sync.js)
```js
function safeMoveToBackup(pathToMove) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = join(CLAW_HOME, 'backups', 'skills-conflicts', stamp);
    const backupPath = join(backupRoot, pathToMove.replace(/^\/+/, '').replace(/\//g, '__'));
    fs.mkdirSync(dirname(backupPath), { recursive: true });
    fs.renameSync(pathToMove, backupPath);
    return backupPath;
}

function ensureSymlinkSafe(target, linkPath, { onConflict = 'backup' } = {}) {
    try {
        const stat = fs.lstatSync(linkPath);
        // 링크가 이미 올바른 타겟이면 무변경
        if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) === target) {
            return { status: 'ok', action: 'noop', linkPath };
        }
        // 링크/실디렉토리 충돌은 backup 우선
        if (onConflict === 'backup') {
            const backupPath = safeMoveToBackup(linkPath);
            fs.mkdirSync(dirname(linkPath), { recursive: true });
            fs.symlinkSync(target, linkPath);
            return { status: 'ok', action: 'backup', linkPath, backupPath };
        }
        return { status: 'skip', action: 'conflict', linkPath };
    } catch {
        fs.mkdirSync(dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath);
        return { status: 'ok', action: 'create', linkPath };
    }
}
```

### 코드 스니펫 (ensureSkillsSymlinks 반환 확장)
```js
export function ensureSkillsSymlinks(workingDir, opts = {}) {
    const result = [];
    // ...
    result.push(ensureSymlinkSafe(skillsSource, wdClaudeSkills, opts));
    result.push(ensureSymlinkSafe(skillsSource, homeClaudeSkills, opts));
    return result;
}
```

### 완료 기준
- 실디렉토리 충돌 시 삭제되지 않고 백업됨
- 백업 경로가 로그/API 응답에 기록됨

---

## 1-2. CLI/모델 단일 소스 (`cli-registry`)

### 문제
- 현재 CLI/모델 목록이 여러 파일에 하드코딩되어 불일치

### 상세 이유 (왜 지금 필요한가)
- 실제로 `src/commands.js`와 `public/js/constants.js`의 OpenCode 모델 목록이 다름.
- 이 상태에서는 UI에서 선택 가능한 모델과 실제 실행 가능 모델이 어긋날 수 있음.
- 최근 커밋 체인(`c16b0d8`, 문서 커밋 다수)에서도 동일 영역 수정이 반복되어 drift 위험이 커졌음.

### 설계
- 백엔드 공통 registry 1개로 관리
- 프론트는 API로 registry 수신 후 UI 렌더

### 신규 파일 스니펫 (`src/cli-registry.js`)
```js
export const CLI_REGISTRY = {
    claude: {
        label: 'Claude',
        binary: 'claude',
        defaultModel: 'claude-sonnet-4-6',
        efforts: ['low', 'medium', 'high'],
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    },
    codex: {
        label: 'Codex',
        binary: 'codex',
        defaultModel: 'gpt-5.3-codex',
        efforts: ['low', 'medium', 'high'],
        models: ['gpt-5.3-codex', 'gpt-5.2-codex'],
    },
    gemini: {
        label: 'Gemini',
        binary: 'gemini',
        defaultModel: 'gemini-2.5-pro',
        efforts: [''],
        models: ['gemini-2.5-pro', 'gemini-3.1-pro-preview'],
    },
    opencode: {
        label: 'OpenCode',
        binary: 'opencode',
        defaultModel: 'anthropic/claude-opus-4-6-thinking',
        efforts: [''],
        models: ['anthropic/claude-opus-4-6-thinking', 'openai/gpt-5.3-codex-xhigh'],
    },
};

export const CLI_KEYS = Object.keys(CLI_REGISTRY);
```

### 코드 스니펫 (config.js)
```js
import { CLI_REGISTRY, CLI_KEYS } from './cli-registry.js';

function buildDefaultPerCli() {
    const perCli = {};
    for (const key of CLI_KEYS) {
        const item = CLI_REGISTRY[key];
        perCli[key] = { model: item.defaultModel, effort: item.efforts[0] || '' };
    }
    return perCli;
}

export const DEFAULT_SETTINGS = {
    cli: 'claude',
    perCli: buildDefaultPerCli(),
    // ...
};

export function detectAllCli() {
    const out = {};
    for (const key of CLI_KEYS) out[key] = detectCli(CLI_REGISTRY[key].binary);
    return out;
}
```

### 코드 스니펫 (commands.js)
```js
import { CLI_REGISTRY, CLI_KEYS } from './cli-registry.js';

const DEFAULT_CLI_CHOICES = CLI_KEYS;
const MODEL_CHOICES_BY_CLI = Object.fromEntries(
    CLI_KEYS.map(k => [k, CLI_REGISTRY[k].models])
);
```

### 코드 스니펫 (server.js API)
```js
import { CLI_REGISTRY } from './src/cli-registry.js';

app.get('/api/cli-registry', (_, res) => {
    res.json(CLI_REGISTRY);
});
```

### 코드 스니펫 (frontend)
```js
// public/js/constants.js
export async function fetchCliRegistry() {
    return (await fetch('/api/cli-registry')).json();
}

// settings.js / employees.js에서 하드코딩 배열 제거
const registry = await fetchCliRegistry();
const cliKeys = Object.keys(registry);
```

### 완료 기준
- CLI/모델 변경 시 수정 지점이 registry 중심으로 축소
- 프론트/백엔드 모델 목록 diff 0건

---

## 1-3. Copilot 문서-코드 갭 정리

### 문제
- `devlog/260225_copilot-cli-integration` 문서와 실제 구현 상태가 분리됨

### 상세 이유 (왜 지금 필요한가)
- 최근 15개 중 문서 커밋이 다수이며, 코드 미반영 상태로 계획 문서만 선행되는 구간이 존재함.
- 문서와 코드 상태가 분리되면 후속 구현 우선순위 판단이 흔들리고, 중복 작업이 발생함.

### 설계
- 문서에 체크리스트 상태를 명시
- 코드 기준 truth table 유지

### 문서 템플릿 스니펫 (`status.md`)
```md
## 구현 상태 매트릭스

| 항목 | 문서 계획 | 코드 상태 | 근거 파일 | 상태 |
|------|-----------|-----------|----------|------|
| CLI detect copilot | 있음 | 없음 | src/config.js | ❌ |
| CLI select UI | 있음 | 없음 | public/index.html | ❌ |
| ACP client | 있음 | 없음 | src/acp-client.js | ❌ |
```

### 자동 점검 스니펫 (`scripts/check-copilot-gap.js`)
```js
import fs from 'fs';

const checks = [
    { name: 'detectAllCli copilot', file: 'src/config.js', needle: "copilot: detectCli('copilot')" },
    { name: 'UI option copilot', file: 'public/index.html', needle: 'value=\"copilot\"' },
];

const failed = checks.filter(c => !fs.readFileSync(c.file, 'utf8').includes(c.needle));
if (failed.length) {
    console.error('MISSING:', failed.map(f => f.name).join(', '));
    process.exit(1);
}
console.log('OK');
```

### 완료 기준
- 문서 체크리스트와 코드 상태가 항상 동기화
- 배포 전 갭 점검 스크립트 실행 가능

---

## 검증 명령
```bash
# symlink 보호 동작 확인
node bin/postinstall.js

# registry API 확인
curl -s http://localhost:3457/api/cli-registry | jq

# copilot 문서-코드 갭 검사
node scripts/check-copilot-gap.js
```

---

## 권장 커밋 단위
1. `[safety] skills symlink: conflict backup mode`
2. `[refactor] cli/model registry single source`
3. `[docs] copilot integration status matrix + checker script`
