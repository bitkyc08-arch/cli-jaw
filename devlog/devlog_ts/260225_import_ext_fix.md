# Import Extension Fix: .js → .ts

> Date: 2026-02-25
> Scope: 프로젝트 전체

## 문제

`tsconfig.json`에 `noEmit: true` + `allowImportingTsExtensions: true` 설정으로
빌드 없이 `tsx`로 직접 실행하는 구조인데, import 경로에 `.js` 확장자가 남아 있었음.

- **Static imports**: tsx가 `.js` → `.ts` 자동 매핑해주므로 동작은 했으나, 타입 체크 시 혼동
- **Dynamic imports** (`await import('./foo.js')`): tsx에서 resolve 실패 → `ERR_MODULE_NOT_FOUND`

## 수정 내역

### Source 파일 (6개)

| 파일 | 수정 건수 |
|------|----------|
| `bin/cli-claw.ts` | 11 (모든 subcommand import) |
| `bin/commands/init.ts` | 1 |
| `bin/commands/skill.ts` | 1 |
| `server.ts` | 2 (`mcp-sync`) |
| `src/telegram/bot.ts` | 5 (`config`, `browser`, `spawn`) |
| `src/agent/spawn.ts` | 3 (`pipeline`, `builder`) |

### Test 파일 (18개)

`tests/unit/` 및 `tests/` 하위 모든 `.test.ts`에서 `.js` → `.ts` 일괄 변경.

### serve.ts 런타임 수정

`bin/commands/serve.ts`에서 `node server.js`를 spawn하던 것을
`tsx server.ts`로 변경. tsx 바이너리는 `node_modules/.bin/tsx`에서 우선 탐색.

### Shebang 변경

`bin/cli-claw.ts` shebang: `#!/usr/bin/env node` → `#!/usr/bin/env npx tsx`

## 검증

- `import-resolve.test.ts` ✅ (PASS)
- `tsx bin/cli-claw.ts serve` → 서버 정상 기동 확인

## 예외

- `tests/unit/frontend-constants.test.ts` — `public/js/constants.js`는 실제 JS 파일이므로 `.js` 유지
- 기존 lint 에러 (implicit any, null assignability 등)는 TS 마이그레이션 Phase 작업 범위로 별도 추적

## 후속: tsc 빌드 방식 채택

최종적으로 `tsc` 빌드 후 `dist/` 배포 방식을 채택함에 따라,
소스 파일의 import 확장자는 `.js`로 되돌림 (NodeNext 모듈 해석 규칙).
tsx 직접 실행은 `npm run dev` (개발 전용)에서만 사용.

→ 관련 devlog: `260225_dist_build_compat.md`
