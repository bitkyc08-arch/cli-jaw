import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error - the production checker is an ESM JavaScript CLI with testable exports
import {
    DEFAULT_APP_RELATIVE_PATH,
    GLOBAL_RETIRED_MARKERS,
    PAGE_WORLD_MARKERS,
    PRELOAD_MARKERS,
    checkElectronRuntimeParity,
    compareManifests,
    createTreeManifest,
    findForbiddenMarkers,
    loadBuilderServerExclusions,
    resolveArtifactPaths,
} from '../../scripts/check-electron-runtime-parity.mjs';

type Fixture = {
    root: string;
    appPath: string;
    outMain: string;
    asarEntries: Record<string, Buffer>;
    readAsarEntry: (_asarPath: string, entryPath: string) => Promise<Buffer>;
};

const BUILDER_CONFIG = `extraResources:
  - from: sidecar/server
    to: server
    filter:
      - "**/*"
      - "!**/*.ts"
      - "!**/*.map"
      - "!**/test*"
      - "!**/.cache"
      - "!**/.DS_Store"
      - "!**/.gitkeep"
`;

function write(path: string, content: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

function makeFixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never): Fixture {
    const root = mkdtempSync(join(tmpdir(), 'jaw-electron-parity-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const appPath = join(root, DEFAULT_APP_RELATIVE_PATH);
    const sourcePublic = join(root, 'public', 'dist');
    const sidecar = join(root, 'electron', 'sidecar', 'server');
    const packagedServer = join(appPath, 'Contents', 'Resources', 'server');
    const outMain = join(root, 'electron', 'out', 'main', 'index.js');
    const outPreload = join(root, 'electron', 'out', 'preload', 'index.js');

    write(join(root, 'electron', 'electron-builder.yml'), BUILDER_CONFIG);
    write(join(sourcePublic, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
    write(join(sourcePublic, 'assets', 'app.js'), 'console.log("page world clean");');
    cpSync(sourcePublic, join(sidecar, 'public', 'dist'), { recursive: true });

    const legitimateOwnerText = 'const route = "/api/dashboard/electron-metrics"; const header = "X-CLI-Jaw-Electron"; const token = "CLI_JAW_ELECTRON_RENDERER_TOKEN";';
    write(join(sidecar, 'dist', 'server.js'), legitimateOwnerText);
    write(join(sidecar, 'node'), 'node-binary-fixture');
    write(join(sidecar, 'package.json'), '{"name":"sidecar-fixture"}');
    write(join(sidecar, 'src', 'excluded.ts'), 'not packaged');
    write(join(sidecar, 'dist', 'server.js.map'), 'not packaged');
    write(join(sidecar, 'test-fixture.js'), 'not packaged');
    write(join(sidecar, '.cache', 'stale.js'), 'not packaged');

    cpSync(join(sidecar, 'public'), join(packagedServer, 'public'), { recursive: true });
    cpSync(join(sidecar, 'dist'), join(packagedServer, 'dist'), {
        recursive: true,
        filter: (path) => !path.endsWith('.map'),
    });
    cpSync(join(sidecar, 'node'), join(packagedServer, 'node'));
    cpSync(join(sidecar, 'package.json'), join(packagedServer, 'package.json'));

    write(outMain, legitimateOwnerText);
    write(outPreload, 'contextBridge.exposeInMainWorld("cliJawDesktop", {});');
    write(join(appPath, 'Contents', 'Resources', 'app.asar'), 'fixture placeholder; never packaged by this test');

    const asarEntries = {
        'out/main/index.js': readFileSync(outMain),
        'out/preload/index.js': readFileSync(outPreload),
    };
    return {
        root,
        appPath,
        outMain,
        asarEntries,
        readAsarEntry: async (_asarPath, entryPath) => {
            const entry = asarEntries[entryPath];
            if (!entry) throw new Error(`missing fake ASAR entry: ${entryPath}`);
            return entry;
        },
    };
}

test('tree manifests report missing, extra, and stale files by relative path', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-electron-manifest-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const expectedRoot = join(root, 'expected');
    const actualRoot = join(root, 'actual');
    write(join(expectedRoot, 'same.js'), 'same');
    write(join(expectedRoot, 'stale.js'), 'new');
    write(join(expectedRoot, 'missing.js'), 'missing');
    write(join(actualRoot, 'same.js'), 'same');
    write(join(actualRoot, 'stale.js'), 'old');
    write(join(actualRoot, 'extra.js'), 'extra');

    const issues = compareManifests(
        createTreeManifest(expectedRoot),
        createTreeManifest(actualRoot),
        'fixture boundary',
    ) as string[];
    assert.ok(issues.some((issue) => issue.includes('missing in target: missing.js')));
    assert.ok(issues.some((issue) => issue.includes('extra in target: extra.js')));
    assert.ok(issues.some((issue) => issue.includes('stale/content mismatch: stale.js')));
});

test('builder exclusions are loaded from electron-builder.yml and applied to the sidecar manifest', (t) => {
    const fixture = makeFixture(t);
    const configPath = join(fixture.root, 'electron', 'electron-builder.yml');
    const exclusions = loadBuilderServerExclusions(configPath) as string[];
    const sidecarRoot = join(fixture.root, 'electron', 'sidecar', 'server');
    const paths = (createTreeManifest(sidecarRoot, { excludePatterns: exclusions }) as Array<{ path: string }>).map((entry) => entry.path);

    assert.deepEqual(exclusions, ['**/*.ts', '**/*.map', '**/test*', '**/.cache', '**/.DS_Store', '**/.gitkeep']);
    assert.equal(paths.includes('src/excluded.ts'), false);
    assert.equal(paths.includes('dist/server.js.map'), false);
    assert.equal(paths.includes('test-fixture.js'), false);
    assert.equal(paths.includes('.cache/stale.js'), false);
    assert.ok(paths.includes('dist/server.js'));
});

test('fixture parity accepts exact trees and ASAR hashes while preserving main/server metrics owners', async (t) => {
    const fixture = makeFixture(t);
    const report = await checkElectronRuntimeParity({
        projectRoot: fixture.root,
        readAsarEntry: fixture.readAsarEntry,
    }) as { appPath: string; fileCounts: Record<string, number> };

    assert.equal(report.appPath, fixture.appPath);
    assert.ok(report.fileCounts.sourcePublic > 0);
    assert.equal(report.fileCounts.sidecar, report.fileCounts.packagedServer);
});

test('stale public/dist and ASAR entries fail with explicit artifact boundaries', async (t) => {
    const stalePublic = makeFixture(t);
    write(join(stalePublic.root, 'electron', 'sidecar', 'server', 'public', 'dist', 'assets', 'app.js'), 'stale page world');
    await assert.rejects(
        checkElectronRuntimeParity({ projectRoot: stalePublic.root, readAsarEntry: stalePublic.readAsarEntry }),
        /public\/dist -> sidecar public\/dist: stale\/content mismatch: assets\/app\.js/,
    );

    const staleAsar = makeFixture(t);
    staleAsar.asarEntries['out/preload/index.js'] = Buffer.from('stale preload');
    await assert.rejects(
        checkElectronRuntimeParity({ projectRoot: staleAsar.root, readAsarEntry: staleAsar.readAsarEntry }),
        /electron\/out preload -> app\.asar: stale\/content mismatch: out\/preload\/index\.js/,
    );
});

test('retired markers are global while preload and page-world markers stay correctly scoped', () => {
    for (const marker of GLOBAL_RETIRED_MARKERS as Array<{ name: string; sample: string }>) {
        assert.deepEqual(findForbiddenMarkers(marker.sample, GLOBAL_RETIRED_MARKERS), [marker.name]);
    }
    for (const marker of PRELOAD_MARKERS as Array<{ name: string; sample: string }>) {
        assert.deepEqual(findForbiddenMarkers(marker.sample, PRELOAD_MARKERS), [marker.name]);
    }
    for (const marker of PAGE_WORLD_MARKERS as Array<{ name: string; sample: string }>) {
        assert.deepEqual(findForbiddenMarkers(marker.sample, PAGE_WORLD_MARKERS), [marker.name]);
    }
    const legitimateMainServerOwner = '/api/dashboard/electron-metrics X-CLI-Jaw-Electron CLI_JAW_ELECTRON_RENDERER_TOKEN';
    assert.deepEqual(findForbiddenMarkers(legitimateMainServerOwner, GLOBAL_RETIRED_MARKERS), []);
    assert.deepEqual(findForbiddenMarkers('/api/dashboard/electron-metrics', PAGE_WORLD_MARKERS), [], 'page world may GET the latest metrics snapshot');
});

test('retired poller code fails even when ASAR bytes otherwise match', async (t) => {
    const fixture = makeFixture(t);
    write(fixture.outMain, 'function pullAndPost() {}');
    fixture.asarEntries['out/main/index.js'] = readFileSync(fixture.outMain);
    await assert.rejects(
        checkElectronRuntimeParity({ projectRoot: fixture.root, readAsarEntry: fixture.readAsarEntry }),
        /electron\/out\/main\/index\.js: forbidden marker "pullAndPost"/,
    );
});

test('default app path, command registration, locked ASAR dependency, and missing-artifact failure are explicit', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-electron-missing-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const resolved = resolveArtifactPaths({ projectRoot: root }) as { appPath: string };
    assert.equal(resolved.appPath, join(root, DEFAULT_APP_RELATIVE_PATH));

    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
    };
    assert.equal(packageJson.scripts['check:electron-runtime-parity'], 'node scripts/check-electron-runtime-parity.mjs');
    assert.equal(packageJson.devDependencies['@electron/asar'], '3.4.1');

    await assert.rejects(
        checkElectronRuntimeParity({ projectRoot: root, readAsarEntry: async () => Buffer.alloc(0) }),
        /source public\/dist directory missing:/,
    );
});
