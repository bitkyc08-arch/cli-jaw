import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
const safePath = ['/usr/bin', '/bin'].join(':');
const env = { ...process.env, PATH: safePath };

const globalJwc = spawnSync('sh', ['-c', 'command -v jwc'], {
	encoding: 'utf8',
	env,
});
assert.notEqual(globalJwc.status, 0, `expected no global jwc in smoke PATH, got ${globalJwc.stdout.trim()}`);

const runtimeSource = readFileSync(join(repoRoot, 'src/agent/jwc-runtime.ts'), 'utf8');
assert.equal(packageJson.dependencies?.jawcode, undefined, 'cli-jaw npm installs must not pull jawcode by default');
assert.equal(packageJson.optionalDependencies?.jawcode, undefined, 'jawcode must not be an npm optional dependency because optional deps install by default');
assert.equal(packageLock.packages?.['']?.dependencies?.jawcode, undefined, 'package-lock root must not pull jawcode by default');
assert.equal(packageLock.packages?.['']?.optionalDependencies?.jawcode, undefined, 'package-lock root must not pull optional jawcode by default');
assert.equal(packageLock.packages?.['node_modules/jawcode'], undefined, 'package-lock must not include jawcode in the default install tree');
assert.equal(packageLock.packages?.['node_modules/@jawcode-dev/natives'], undefined, 'package-lock must not include @jawcode-dev/natives in the default install tree');
assert.equal(packageLock.packages?.['node_modules/bun'], undefined, 'package-lock must not include bun from JWC in the default install tree');
assert.ok(runtimeSource.includes("'jawcode/sdk'"), 'jwc runtime must default to jawcode/sdk');
assert.ok(!runtimeSource.includes("'jwc/sdk'"), 'jwc runtime must not default to jwc/sdk');
assert.ok(runtimeSource.includes('does not bundle JWC'), 'jwc runtime must explain that JWC is not bundled');
assert.ok(runtimeSource.includes('JWC_SDK_PATH=/absolute/path/to/jawcode/packages/jwc/dist-node/sdk.js'), 'jwc runtime must show the install path env override');

process.stdout.write('[jwc no-global] global jwc absent; cli-jaw excludes bundled JWC and runtime guidance is present\n');
