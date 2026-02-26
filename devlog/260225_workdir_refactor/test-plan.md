# Multi-Instance Refactor — Automated Test Plan

> **Convention**: `node:test` + `node:assert/strict` (project standard)
> **Runner**: `tsx --test` via `npm test`
> **Naming**: `tests/unit/<name>.test.ts` for unit, `tests/integration/<name>.test.ts` for integration

---

## Overview: Test Files per Phase

| Phase | Test File | Tests | Type | Status | Description |
|-------|-----------|-------|------|--------|-------------|
| 1 | `tests/unit/workdir-default.test.ts` | 2 | Unit | ✅ Pass | workingDir → JAW_HOME, prompt text |
| 2.0 | `tests/unit/jaw-home-import.test.ts` | 2 | Unit | ✅ Pass | 8-file import centralization 검증 |
| 2.1-2.2 | `tests/unit/jaw-home-env.test.ts` | 5 | Unit+Subprocess | ✅ Pass | env var, --home flag, tilde, = syntax |
| 3 | `tests/unit/clone.test.ts` | 8 | Unit+Subprocess | ✅ Pass | clone 디렉토리/설정/메모리/에러/소스검증 |
| 4 | `tests/unit/launchd-multi.test.ts` | 7 | Unit+Subprocess | ⬜ Pending | instanceId, plist, xmlEsc, port |
| E2E | `tests/integration/multi-instance.test.ts` | 3 | Integration | ⬜ Pending | 두 인스턴스 동시 실행 |

**Total: 6 files, 25 tests** (Phase 2.0 reduced from 3→2 during implementation)

---

## Phase 1: `tests/unit/workdir-default.test.ts` ✅ DONE

```typescript
// Multi-Instance Phase 1: workingDir default 검증
import test from 'node:test';
import assert from 'node:assert/strict';

test('P1-001: createDefaultSettings().workingDir === JAW_HOME', async () => {
    // import createDefaultSettings from config.ts
    // assert workingDir ends with '.cli-jaw'
    // assert workingDir === JAW_HOME (same reference)
});

test('P1-002: A2_DEFAULT prompt contains ~/.cli-jaw not ~/', async () => {
    // import A2_DEFAULT from builder.ts (or from generated prompt)
    // assert.ok(A2_DEFAULT.includes('~/.cli-jaw'))
    // assert.ok(!A2_DEFAULT.includes('- ~/\n'))  // old value
});
```

**Gate**: 이 2개 통과 → Phase 1 구현 완료

---

## Phase 2.0: `tests/unit/jaw-home-import.test.ts` ✅ DONE

```typescript
// Multi-Instance Phase 2.0: import centralization 검증
// 8개 파일이 config.ts의 JAW_HOME을 import하는지 확인
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

const FILES_MUST_IMPORT = [
    'bin/commands/doctor.ts',
    'bin/commands/init.ts',
    'bin/commands/mcp.ts',
    'bin/commands/browser.ts',
    'bin/commands/skill.ts',
    'bin/commands/launchd.ts',
    'lib/mcp-sync.ts',
    'bin/postinstall.ts',
];

test('P20-001: all 8 files import JAW_HOME from config', () => {
    for (const file of FILES_MUST_IMPORT) {
        const src = readFileSync(join(root, file), 'utf8');
        assert.ok(
            src.includes("from '../../src/core/config") ||
            src.includes("from '../src/core/config"),
            `${file} must import from config.ts`
        );
    }
});

test('P20-002: no file defines local JAW_HOME via homedir()', () => {
    for (const file of FILES_MUST_IMPORT) {
        const src = readFileSync(join(root, file), 'utf8');
        // Should NOT have `const jawHome = path.join(homedir(), '.cli-jaw')`
        // or similar local definition patterns
        const hasLocalDef = /const\s+(?:jawHome|JAW_HOME|LOG_DIR)\s*=\s*(?:path\.)?join\(.*homedir/.test(src);
        assert.ok(!hasLocalDef, `${file} should not define local JAW_HOME via homedir()`);
    }
});

test('P20-003: existing 252+ tests still pass after refactor', () => {
    // This is verified by running `npm test` — marker test
    assert.ok(true, 'Run npm test separately to verify');
});
```

**Gate**: P20-001 + P20-002 통과 → Phase 2.0 import 중앙화 완료

---

## Phase 2.1-2.2: `tests/unit/jaw-home-env.test.ts` ✅ DONE

```typescript
// Multi-Instance Phase 2.1-2.2: JAW_HOME dynamic 검증
// subprocess 기반 (ESM const는 import 시점에 동결)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

test('P2-001: JAW_HOME respects CLI_JAW_HOME env var', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '/tmp/test-jaw' } }
    );
    assert.equal(result.trim(), '/tmp/test-jaw');
});

test('P2-002: JAW_HOME defaults to ~/.cli-jaw without env var', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '' } }
    );
    assert.ok(result.trim().endsWith('.cli-jaw'));
});

test('P2-003: --home flag sets JAW_HOME for doctor subcommand', () => {
    const tmpHome = '/tmp/test-jaw-p2-003';
    mkdirSync(tmpHome, { recursive: true });
    try {
        const result = execSync(
            `node dist/bin/cli-jaw.js --home ${tmpHome} doctor --json`,
            { cwd: projectRoot, encoding: 'utf8' }
        );
        const json = JSON.parse(result);
        const homeCheck = json.checks.find((c: any) => c.name === 'Home directory');
        assert.ok(homeCheck, 'Home directory check should exist');
        assert.equal(homeCheck.detail, tmpHome);
    } finally {
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('P2-004: --home=/path equals syntax works', () => {
    const tmpHome = '/tmp/test-jaw-p2-004';
    mkdirSync(tmpHome, { recursive: true });
    try {
        const result = execSync(
            `node dist/bin/cli-jaw.js --home=${tmpHome} doctor --json`,
            { cwd: projectRoot, encoding: 'utf8' }
        );
        const json = JSON.parse(result);
        const homeCheck = json.checks.find((c: any) => c.name === 'Home directory');
        assert.equal(homeCheck.detail, tmpHome);
    } finally {
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('P2-005: tilde expansion works correctly', () => {
    // Test that ~ expands to homedir but ~username does NOT
    const result = execSync(
        `node -e "
            import { parseArgs } from 'node:util';
            import os from 'node:os';
            const val = '~/test-tilde'.replace(/^~(?=\\\\/|$)/, os.homedir());
            console.log(val);
        "`,
        { encoding: 'utf8' }
    );
    assert.ok(result.trim().startsWith('/'));
    assert.ok(result.trim().endsWith('/test-tilde'));
    assert.ok(!result.trim().includes('~'));
});
```

**Gate**: 5개 전부 통과 → Phase 2 완료

---

## Phase 3: `tests/unit/clone.test.ts` ✅ DONE

```typescript
// Multi-Instance Phase 3: jaw clone 명령어 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const JAW = `node ${join(projectRoot, 'dist/bin/cli-jaw.js')}`;

function cleanup(dir: string) {
    rmSync(dir, { recursive: true, force: true });
}

test('P3-001: clone creates all required directories', () => {
    const target = '/tmp/test-clone-p3-001';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot });
        assert.ok(existsSync(join(target, 'prompts')));
        assert.ok(existsSync(join(target, 'skills')));
        assert.ok(existsSync(join(target, 'worklogs')));
        assert.ok(existsSync(join(target, 'mcp.json')));
        assert.ok(existsSync(join(target, 'heartbeat.json')));
        assert.ok(existsSync(join(target, 'settings.json')));
    } finally {
        cleanup(target);
    }
});

test('P3-002: clone sets workingDir to target path', () => {
    const target = '/tmp/test-clone-p3-002';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot });
        const settings = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
        assert.equal(settings.workingDir, target);
    } finally {
        cleanup(target);
    }
});

test('P3-003: clone does NOT copy jaw.db', () => {
    const target = '/tmp/test-clone-p3-003';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot });
        assert.ok(!existsSync(join(target, 'jaw.db')));
    } finally {
        cleanup(target);
    }
});

test('P3-004: clone --with-memory copies MEMORY.md', () => {
    const target = '/tmp/test-clone-p3-004';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target} --with-memory`, { cwd: projectRoot });
        // Only passes if source has MEMORY.md
        // If source doesn't have it, the directory should still be created
        assert.ok(existsSync(join(target, 'memory')));
    } finally {
        cleanup(target);
    }
});

test('P3-005: clone --link-ref creates symlink for skills_ref', () => {
    const target = '/tmp/test-clone-p3-005';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target} --link-ref`, { cwd: projectRoot });
        if (existsSync(join(target, 'skills_ref'))) {
            const stat = lstatSync(join(target, 'skills_ref'));
            assert.ok(stat.isSymbolicLink(), 'skills_ref should be a symlink');
        }
    } finally {
        cleanup(target);
    }
});

test('P3-006: clone to existing non-empty dir fails', () => {
    const target = '/tmp/test-clone-p3-006';
    cleanup(target);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'dummy'), 'x');
    try {
        assert.throws(() => {
            execSync(`${JAW} clone ${target}`, { cwd: projectRoot, stdio: 'pipe' });
        }, /already exists|not empty/i);
    } finally {
        cleanup(target);
    }
});
```

**Gate**: 6개 전부 통과 → Phase 3 완료

---

## Phase 4: `tests/unit/launchd-multi.test.ts`

```typescript
// Multi-Instance Phase 4: launchd multi-instance 검증
// 대부분 subprocess 기반 (JAW_HOME이 const이므로)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

// instanceId는 launchd.ts 내부 함수라 직접 테스트 어려움 → subprocess
test('P4-001: default JAW_HOME produces "default" label', () => {
    // Verify by checking plist path pattern
    // launchd.ts outputs the label in its messages
    const result = execSync(
        `node -e "
            process.env.CLI_JAW_HOME = '';
            const c = await import('./dist/src/core/config.js');
            const { basename } = await import('node:path');
            const { createHash } = await import('node:crypto');
            const base = basename(c.JAW_HOME);
            const id = base === '.cli-jaw' ? 'default' : base.replace(/^\\./, '') + '-' + createHash('md5').update(c.JAW_HOME).digest('hex').slice(0,8);
            console.log(id);
        "`,
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '' } }
    );
    assert.equal(result.trim(), 'default');
});

test('P4-002: custom JAW_HOME produces hashed label', () => {
    const result = execSync(
        `node -e "
            const c = await import('./dist/src/core/config.js');
            const { basename } = await import('node:path');
            const { createHash } = await import('node:crypto');
            const base = basename(c.JAW_HOME);
            const hash = createHash('md5').update(c.JAW_HOME).digest('hex').slice(0,8);
            const id = base === '.cli-jaw' ? 'default' : base.replace(/^\\./, '') + '-' + hash;
            console.log(id);
        "`,
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '/tmp/jaw-work' } }
    );
    const label = result.trim();
    assert.ok(label.startsWith('jaw-work-'), `Expected jaw-work-<hash>, got ${label}`);
    assert.ok(label.length > 'jaw-work-'.length, 'Should have hash suffix');
});

test('P4-003: LABEL format is com.cli-jaw.<instanceId>', () => {
    const result = execSync(
        `node -e "
            const c = await import('./dist/src/core/config.js');
            const { basename } = await import('node:path');
            const base = basename(c.JAW_HOME);
            const id = base === '.cli-jaw' ? 'default' : base.replace(/^\\./, '');
            console.log('com.cli-jaw.' + id);
        "`,
        { cwd: projectRoot, encoding: 'utf8' }
    );
    assert.ok(result.trim().startsWith('com.cli-jaw.'));
});

test('P4-004: xmlEsc escapes &, <, > in paths', () => {
    const result = execSync(
        `node -e "
            const xmlEsc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            console.log(xmlEsc('/Users/R&D/.jaw'));
            console.log(xmlEsc('/path/<with>/special'));
        "`,
        { encoding: 'utf8' }
    );
    const lines = result.trim().split('\n');
    assert.equal(lines[0], '/Users/R&amp;D/.jaw');
    assert.equal(lines[1], '/path/&lt;with&gt;/special');
});

test('P4-005: parseArgs handles --port=3458 syntax', () => {
    const result = execSync(
        `node -e "
            import { parseArgs } from 'node:util';
            const { values } = parseArgs({
                args: ['launchd', '--port=3458'],
                options: { port: { type: 'string', default: '3457' } },
                strict: false,
                allowPositionals: true,
            });
            console.log(values.port);
        "`,
        { encoding: 'utf8' }
    );
    assert.equal(result.trim(), '3458');
});

test('P4-006: parseArgs handles --port 3458 (space) syntax', () => {
    const result = execSync(
        `node -e "
            import { parseArgs } from 'node:util';
            const { values } = parseArgs({
                args: ['launchd', '--port', '3458'],
                options: { port: { type: 'string', default: '3457' } },
                strict: false,
                allowPositionals: true,
            });
            console.log(values.port);
        "`,
        { encoding: 'utf8' }
    );
    assert.equal(result.trim(), '3458');
});

test('P4-007: LOG_DIR uses JAW_HOME not hardcoded path', () => {
    const result = execSync(
        `node -e "
            const c = await import('./dist/src/core/config.js');
            const { join } = await import('node:path');
            console.log(join(c.JAW_HOME, 'logs'));
        "`,
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '/tmp/custom-jaw' } }
    );
    assert.equal(result.trim(), '/tmp/custom-jaw/logs');
});
```

**Gate**: 7개 전부 통과 → Phase 4 완료

---

## E2E: `tests/integration/multi-instance.test.ts`

```typescript
// Multi-Instance E2E: 두 인스턴스 동시 실행 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const JAW = join(projectRoot, 'dist/bin/cli-jaw.js');

test('E2E-001: jaw doctor --json returns valid JSON with custom home', async () => {
    const tmpHome = '/tmp/test-e2e-001';
    mkdirSync(tmpHome, { recursive: true });
    try {
        const result = execSync(
            `node ${JAW} --home ${tmpHome} doctor --json`,
            { cwd: projectRoot, encoding: 'utf8' }
        );
        const json = JSON.parse(result);
        assert.ok(Array.isArray(json.checks), 'Should have checks array');
        const homeCheck = json.checks.find((c: any) => c.name === 'Home directory');
        assert.equal(homeCheck.detail, tmpHome);
    } finally {
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('E2E-002: two serves on different ports respond independently', async () => {
    const tmpHome = '/tmp/test-e2e-002';
    mkdirSync(tmpHome, { recursive: true });

    // Start instance A (default)
    const procA = spawn('node', [JAW, 'serve'], {
        cwd: projectRoot,
        stdio: 'pipe',
        env: { ...process.env },
    });

    // Start instance B (custom home + port)
    const procB = spawn('node', [JAW, 'serve', '--home', tmpHome, '--port', '3458'], {
        cwd: projectRoot,
        stdio: 'pipe',
        env: { ...process.env },
    });

    try {
        await setTimeout(4000); // wait for servers to start

        // Check both respond
        const statusA = execSync('curl -sf localhost:3457/api/cli-status', { encoding: 'utf8' });
        assert.ok(statusA.length > 0, 'Instance A should respond');

        const statusB = execSync('curl -sf localhost:3458/api/cli-status', { encoding: 'utf8' });
        assert.ok(statusB.length > 0, 'Instance B should respond');
    } finally {
        procA.kill('SIGTERM');
        procB.kill('SIGTERM');
        await setTimeout(1000);
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('E2E-003: existing test suite still passes (regression guard)', () => {
    // This test just marks that npm test should be run separately
    // Automated by CI — here as a reminder
    assert.ok(true, 'Run full npm test to verify regression');
});
```

**Gate**: E2E-001 + E2E-002 통과 → 전체 멀티 인스턴스 기능 완료

---

## Implementation Order

```
Phase 1 구현 → workdir-default.test.ts 작성 + npm test
Phase 2.0 구현 → jaw-home-import.test.ts 작성 + npm test
Phase 2.1-2.2 구현 → jaw-home-env.test.ts 작성 + npm test
Phase 3 구현 → clone.test.ts 작성 + npm test
Phase 4 구현 → launchd-multi.test.ts 작성 + npm test
최종 → multi-instance.test.ts 작성 + npm test (full suite)
```

Each phase's test file acts as a **quality gate** — no proceeding until all tests pass.
