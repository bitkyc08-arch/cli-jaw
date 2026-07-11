import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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

// 2026-07-11: the JWC Jaw-chat runtime was retired (devlog 012). The former
// src/agent/jwc-runtime.ts assertions are replaced by a retirement guard: the
// chat runtime must NOT come back, while packaging exclusions below still hold
// for the opt-in Code-mode/external JWC (`jaw jwc install`, JWC_SDK_PATH).
assert.ok(!existsSync(join(repoRoot, 'src/agent/jwc-runtime.ts')), 'retired jwc chat runtime must not reappear in src/agent');
assert.ok(!existsSync(join(repoRoot, 'src/agent/jwc-event-mapper.ts')), 'retired jwc event mapper must not reappear in src/agent');
assert.equal(packageJson.dependencies?.jawcode, undefined, 'cli-jaw npm installs must not pull jawcode by default');
assert.equal(packageJson.optionalDependencies?.jawcode, undefined, 'jawcode must not be an npm optional dependency because optional deps install by default');
assert.equal(packageLock.packages?.['']?.dependencies?.jawcode, undefined, 'package-lock root must not pull jawcode by default');
assert.equal(packageLock.packages?.['']?.optionalDependencies?.jawcode, undefined, 'package-lock root must not pull optional jawcode by default');
assert.equal(packageLock.packages?.['node_modules/jawcode'], undefined, 'package-lock must not include jawcode in the default install tree');
assert.equal(packageLock.packages?.['node_modules/@jawcode-dev/natives'], undefined, 'package-lock must not include @jawcode-dev/natives in the default install tree');
assert.equal(packageLock.packages?.['node_modules/bun'], undefined, 'package-lock must not include bun from JWC in the default install tree');

// ai-e must also be excluded from default install (jaw provider install ai-e instead)
assert.equal(packageJson.dependencies?.['@bitkyc08/ai-e'], undefined, 'ai-e must not be a hard dependency');
assert.equal(packageJson.optionalDependencies?.['@bitkyc08/ai-e'], undefined, 'ai-e must not be an optional dependency — use jaw provider install');
assert.equal(packageLock.packages?.['']?.optionalDependencies?.['@bitkyc08/ai-e'], undefined, 'package-lock root must not pull optional ai-e');
assert.equal(packageLock.packages?.['node_modules/@bitkyc08/ai-e'], undefined, 'package-lock must not include ai-e in the default install tree');

process.stdout.write('[jwc no-global] global jwc absent; cli-jaw excludes bundled JWC, ai-e, and runtime guidance is present\n');
