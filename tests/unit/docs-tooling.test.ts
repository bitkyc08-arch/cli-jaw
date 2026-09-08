// Phase 2A docs-tooling contract: checkDocs() compares live AST inventories
// against structure/*.md summary claims and reports drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs } from '../../scripts/docs/check-docs.mts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('DOCS-CHECK-001: checkDocs passes on current committed docs', async () => {
    const issues = await checkDocs();
    assert.deepEqual(issues, [], `expected no drift, got: ${JSON.stringify(issues)}`);
});

test('DOCS-CHECK-002: npm run docs:check script is wired', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['docs:check'], 'tsx scripts/docs/check-docs.mts');
});

// Execute the shipped REST heredoc, including its source collectors and exits.
// Only filesystem inputs are replaced; no checker implementation is copied here.
const shell = readFileSync(new URL('../../structure/check-doc-drift.sh', import.meta.url), 'utf8');
const section = shell.slice(shell.indexOf('check_server_api_doc() {'), shell.indexOf('\ncheck_websocket_doc() {'));
const restChecker = section.match(/if node <<'NODE'\n([\s\S]*?)\nNODE\n/)?.[1];
assert.ok(restChecker, 'the actual REST checker heredoc must be present');
class CheckerExit { constructor(readonly code: number) {} }
type Sources = Map<string, string>;

function runRestChecker(files?: Sources): { code: number; diagnostics: string } {
    const diagnostics: string[] = [];
    const fixtureFs = {
        readFileSync(file: string) {
            const key = file.replaceAll('\\', '/');
            if (!files?.has(key)) throw new Error(`Unexpected fixture read: ${key}`);
            return files.get(key)!;
        },
        readdirSync(directory: string) {
            const prefix = directory.replaceAll('\\', '/') + '/';
            const children = new Map<string, boolean>();
            for (const key of files!.keys()) {
                if (!key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length), slash = rest.indexOf('/');
                children.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
            }
            return [...children].map(([name, directory]) => ({
                name, isDirectory: () => directory, isFile: () => !directory,
            }));
        },
    };
    let code = 0;
    try {
        runInNewContext(restChecker!, {
            require(name: string) {
                if (name === 'fs') return files ? fixtureFs : { readFileSync, readdirSync };
                if (name === 'path') return path;
                if (name === 'typescript') return ts;
                throw new Error(`Unexpected checker dependency: ${name}`);
            },
            console: { error: (...values: unknown[]) => diagnostics.push(values.join(' ')) },
            process: { exit: (status: number) => { throw new CheckerExit(status); } },
        }, { timeout: 5_000 });
    } catch (error) {
        if (error instanceof CheckerExit) code = error.code;
        else { code = 1; diagnostics.push(String(error)); }
    }
    return { code, diagnostics: diagnostics.join('\n') };
}

const apiDoc = 'structure/server_api.md';
const nativeFile = 'src/routes/code-native.ts';
// Independent documented inventory; source registrations are literal below.
const activeCode = [
    'GET /api/code/models', 'GET /api/code/sessions', 'GET /api/code/sessions/:id',
    'GET /api/code/sessions/:id/events', 'GET /api/code/sessions/:id/items',
    'POST /api/code/sessions', 'PATCH /api/code/sessions/:id',
    'POST /api/code/sessions/:id/prompt', 'POST /api/code/sessions/:id/cancel',
    'POST /api/code/sessions/:id/attach', 'POST /api/code/permissions/:id',
    'GET /api/code/git-info', 'POST /api/code/workspace/pick',
];
const ticks = (routes: string[]) => routes.map(route => '`' + route + '`').join(' ');
const summary = '> AST 추출기가 현재 인식하는 범위는 총 242개 route handler다. 이 추출 범위의 API 엔드포인트는 241개이고 `/` 엔트리는 1개다. 전체 API 총수는 아니다. `registerNativeCodeRoutes()` 내부의 `router.*`와 `app.use(prefix, router)` 연결은 아직 집계하지 못한다. 별도로 동작하는 native Code 핸들러 11개는 아래 표에 명시한다. Browser API 1개다.';

function fixture(): Sources {
    // 237 ordinary literals + browser + 2 workspace helpers = 240 API literals;
    // one dynamic API handler and the root preserve the declared 241/242 subset.
    const ordinary = Array.from({ length: 237 }, (_, index) => `/api/fixture/${index}`);
    const entry = (prefix: string) => `
import { registerNativeCodeRoutes } from '${prefix}routes/code-native.js';
import { registerCodeRoutes } from '${prefix}routes/code.js';
registerCodeRoutes(app, requireAuth);
registerNativeCodeRoutes(app, requireAuth, getHost, '/api/code');
`;
    return new Map([
        ['server.ts', entry('./src/') + "app.get('/', handler);\napp.get(/^\\/\\d+$/, handler);\n"
            + ordinary.map(route => `app.get('${route}', handler);`).join('\n')],
        ['src/manager/server.ts', entry('../')],
        ['src/routes/browser.ts', "app.get('/api/browser/status', handler);"],
        ['src/routes/runtime-context.ts', ''], ['src/routes/security-audit.ts', ''],
        ['src/manager/board/routes.ts', ''], ['src/manager/schedule/routes.ts', ''], ['src/routes/jaw-ceo.ts', ''],
        ['src/routes/code.ts', `export function registerCodeRoutes(app, requireAuth) {
    app.get('/api/code/git-info', requireAuth, handler);
    app.post('/api/code/workspace/pick', requireAuth, handler);
}`],
        [nativeFile, `export function registerNativeCodeRoutes(app, requireAuth, getService, prefix = '/api/code') {
    const router = Router();
    const retired = (_req, res) => { fail(res, 410, 'code_endpoint_retired'); };
    router.use(requireAuth);
    router.get('/sessions/stored', retired);
    router.post('/sessions/load', retired);
    for (const path of ['/model-default', '/model-assignments', '/model-presets', '/model-assignments/:role']) router.all(path, retired);
    for (const path of ['/sessions/:id/ext', '/sessions/:id/fork', '/sessions/:id/config', '/sessions/:id/model']) router.all(path, retired);
    router.get('/models', handler);
    router.get('/sessions', handler);
    router.get('/sessions/:id', handler);
    router.get('/sessions/:id/events', handler);
    router.get('/sessions/:id/items', handler);
    router.post('/sessions', handler);
    router.patch('/sessions/:id', handler);
    router.post('/sessions/:id/prompt', handler);
    router.post('/sessions/:id/cancel', handler);
    router.post('/sessions/:id/attach', handler);
    router.post('/permissions/:id', handler);
    router.use(onError);
    app.use(prefix, router);
}`],
        [apiDoc, ['## REST API', '| Domain | Endpoints |', '|---|---|',
            `| Other | ${ticks([...ordinary.map(route => `GET ${route}`), 'GET /api/browser/status'])} |`,
            `| Code Mode | ${ticks(activeCode)} |`, summary, '---', '## WebSocket Events',
            '## Native Code API', 'Compatibility returns 410; it is not an active REST row.',
        ].join('\n')],
    ]);
}

function replace(files: Sources, file: string, before: string, after: string): void {
    const source = files.get(file)!;
    assert.ok(source.includes(before), `mutation must reach ${file}: ${before}`);
    files.set(file, source.replace(before, after));
}
function expectClean(files?: Sources): void {
    const result = runRestChecker(files);
    assert.equal(result.code, 0, result.diagnostics);
}
function expectDrift(files: Sources, message: RegExp): void {
    const result = runRestChecker(files);
    assert.equal(result.code, 1, 'invalid fixture must fail the actual checker');
    assert.match(result.diagnostics, message);
}

test('REST checker accepts current source/docs with native routes outside the subset totals', () => expectClean());
test('REST checker accepts 13 functional Code pairs without inflating 242/241 subset totals', () => expectClean(fixture()));
test('REST checker retains the legacy summary grammar with exact count checks', () => {
    const files = fixture();
    replace(files, apiDoc, summary, '> 기존 수집 범위의 총 242개 route handler 기준이다. 이 중 API 엔드포인트는 241개이고 나머지는 루트다. Browser API 1개다.');
    expectClean(files);
});

for (const [before, after, error] of [
    ['총 242개', '총 253개', /total route handlers/],
    ['241개이고', '252개이고', /API endpoints/],
    ['Browser API 1개', 'Browser API 2개', /browser endpoint count/],
    ['핸들러 11개', '핸들러 10개', /native handler count/],
    ['Browser API 1개', 'Browser API 없음', /missing or duplicate Browser count/],
    ['Browser API 1개', 'Browser API 1개 Browser API 1개', /duplicate Browser count/],
    ['route handler다.', 'route handler.', /summary grammar/],
    ['전체 API 총수는 아니다.', '', /subset boundary/],
    ['연결은 아직 집계하지 못한다.', '연결도 집계한다.', /subset boundary/],
] as const) test(`REST summary rejects ${after || 'missing boundary'}`, () => {
    const files = fixture(); replace(files, apiDoc, before, after); expectDrift(files, error);
});
for (const value of ['', summary + '\n' + summary]) test('REST checker rejects missing or duplicated summary', () => {
    const files = fixture(); replace(files, apiDoc, summary, value); expectDrift(files, /missing or duplicate route summary/);
});

for (const [before, after, error] of [
    ['GET /api/code/models', 'GET /api/code/fabricated', /extra Code route: GET \/api\/code\/fabricated/],
    ['`POST /api/code/sessions/:id/attach`', '', /missing Code route: POST .*attach/],
    ['PATCH /api/code/sessions/:id', 'PUT /api/code/sessions/:id', /extra Code route: PUT/],
    ['GET /api/code/models', 'DELETE /api/code/sessions/:id', /extra Code route: DELETE/],
    ['GET /api/code/models', 'GET /api/code/permissions', /extra Code route: GET .*permissions/],
    ['GET /api/code/models', 'POST /api/code/model-default', /extra Code route: POST .*model-default/],
    ['`GET /api/code/models`', '`GET /api/code/models` `GET /api/code/models`', /duplicate Code route/],
    ['GET /api/code/models', 'FETCH /api/code/models', /malformed Code route/],
] as const) test(`REST Code row rejects ${after}`, () => {
    const files = fixture(); replace(files, apiDoc, before, after); expectDrift(files, error);
});
test('REST checker does not exempt Code routes placed in other rows', () => {
    const files = fixture();
    replace(files, apiDoc, '| Other |', '| Other | `GET /api/code/fabricated`');
    expectDrift(files, /extra routes:[\s\S]*GET \/api\/code\/fabricated/);
});
test('REST checker still rejects drift in ordinary routes', () => {
    const files = fixture(); replace(files, apiDoc, 'GET /api/fixture/0`', 'GET /api/invented`');
    expectDrift(files, /missing routes:[\s\S]*GET \/api\/fixture\/0[\s\S]*extra routes:[\s\S]*GET \/api\/invented/);
});
test('REST checker requires exactly one Code Mode row', () => {
    for (const label of ['Other Code', 'Code Mode | ' + ticks(activeCode) + ' |\n| Code Mode']) {
        const files = fixture(); replace(files, apiDoc, '| Code Mode |', `| ${label} |`);
        expectDrift(files, /missing or duplicate Code row/);
    }
});
test('REST checker separately validates documented compatibility against the actual retired declarations', () => {
    const files = fixture();
    replace(files, apiDoc, '\n---', '\n| Code Mode compatibility (410) | `GET /api/code/sessions/stored` `POST /api/code/model-default` `ALL /api/code/sessions/:id/ext` |\n---');
    expectClean(files);
    replace(files, nativeFile, "'/model-default', ", '');
    expectDrift(files, /unregistered compatibility route: POST \/api\/code\/model-default/);
});
test('REST checker source changes fail even when native count and subset totals stay the same', () => {
    const files = fixture(); replace(files, nativeFile, "router.get('/models'", "router.get('/renamed-models'");
    expectDrift(files, /missing Code route: GET \/api\/code\/renamed-models/);
});
test('REST checker detects a new source registration without relying on its subset count', () => {
    const files = fixture();
    replace(files, nativeFile, "router.get('/models', handler);", "router.get('/models', handler); router.get('/new', handler);");
    expectDrift(files, /missing Code route: GET \/api\/code\/new/);
});
test('REST checker cannot treat a retired registration as functional', () => {
    const files = fixture(); replace(files, nativeFile, "router.get('/models', handler);", "router.get('/models', retired);");
    expectDrift(files, /extra Code route: GET \/api\/code\/models/);
});
test('REST checker derives workspace paths from their registrar instead of exempting them by prefix', () => {
    const files = fixture(); replace(files, 'src/routes/code.ts', '/api/code/git-info', '/api/code/new-git-info');
    expectDrift(files, /missing Code route: GET \/api\/code\/new-git-info/);
});
test('REST checker ignores commented and unrelated-function native registrations', () => {
    const files = fixture();
    files.set(nativeFile, files.get(nativeFile)! + "\n// router.get('/fake-comment', handler);\nfunction example() { router.get('/fake-example', handler); }\n");
    expectClean(files);
});
for (const file of ['server.ts', 'src/manager/server.ts']) {
    test(`REST checker rejects missing or changed ${file} mount`, () => {
        const files = fixture(); replace(files, file, "getHost, '/api/code'", "getHost, '/api/other'");
        expectDrift(files, /native prefix mismatch/);
        replace(files, file, "registerNativeCodeRoutes(app, requireAuth, getHost, '/api/other');", '');
        expectDrift(files, /missing mounted registerNativeCodeRoutes/);
    });
    test(`REST checker rejects unrelated ${file} registrar imports`, () => {
        const files = fixture(); replace(files, file, 'routes/code-native.js', 'routes/unrelated.js');
        expectDrift(files, /missing mounted registerNativeCodeRoutes/);
    });
}
for (const [before, after, error] of [
    ["prefix = '/api/code'", "prefix = '/api/other'", /default prefix changed/],
    ['app.use(prefix, router)', "app.use('/api/other', router)", /router mount changed/],
    ['registerNativeCodeRoutes(app,', 'registerNativeCodeRoutes(other,', /app binding changed/],
    ['const router = Router();', 'const router = other;', /router binding changed/],
    ["router.get('/models', handler);", "if (enabled) router.get('/models', handler);", /nested or computed/],
    ["router.get('/models', handler);", 'router.get(dynamicPath, handler);', /nonliteral/],
    ["router.get('/models', handler);", "router['get']('/models', handler);", /nested or computed/],
    ["fail(res, 410, 'code_endpoint_retired')", "fail(res, 200, 'code_endpoint_retired')", /410 boundary/],
] as const) test(`REST checker rejects unsupported source shape: ${after}`, () => {
    const files = fixture(); replace(files, nativeFile, before, after); expectDrift(files, error);
});
