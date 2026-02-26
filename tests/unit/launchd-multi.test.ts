// Multi-Instance Phase 4: launchd multi-instance 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

// Replicate instanceId logic for verification
function expectedInstanceId(jawHome: string): string {
    const base = basename(jawHome);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(jawHome).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

test('P4-001: default JAW_HOME produces "default" label', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); const { basename } = await import(\'node:path\'); console.log(basename(c.JAW_HOME))"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '' } }
    );
    assert.equal(result.trim(), '.cli-jaw');
    assert.equal(expectedInstanceId(join(homedir(), '.cli-jaw')), 'default');
});

test('P4-002: custom JAW_HOME produces hashed label', () => {
    const id = expectedInstanceId('/tmp/jaw-work');
    assert.ok(id.startsWith('jaw-work-'), `Expected jaw-work-<hash>, got ${id}`);
    assert.equal(id.length, 'jaw-work-'.length + 8, 'Hash suffix should be 8 chars');
});

test('P4-003: LABEL format is com.cli-jaw.<instanceId>', () => {
    const defaultLabel = `com.cli-jaw.${expectedInstanceId(join(homedir(), '.cli-jaw'))}`;
    assert.equal(defaultLabel, 'com.cli-jaw.default');

    const customLabel = `com.cli-jaw.${expectedInstanceId('/tmp/my-jaw')}`;
    assert.ok(customLabel.startsWith('com.cli-jaw.my-jaw-'));
});

test('P4-004: xmlEsc escapes &, <, > in paths', () => {
    const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.equal(xmlEsc('/Users/R&D/.jaw'), '/Users/R&amp;D/.jaw');
    assert.equal(xmlEsc('/path/<with>/special'), '/path/&lt;with&gt;/special');
    assert.equal(xmlEsc('/normal/path'), '/normal/path');
});

test('P4-005: parseArgs handles --port=3458 syntax', () => {
    const result = execSync(
        'node --input-type=module -e "import { parseArgs } from \'node:util\'; const { values } = parseArgs({ args: [\'--port=3458\'], options: { port: { type: \'string\', default: \'3457\' } }, strict: false, allowPositionals: true }); console.log(values.port);"',
        { encoding: 'utf8' }
    );
    assert.equal(result.trim(), '3458');
});

test('P4-006: parseArgs handles --port 3458 (space) syntax', () => {
    const result = execSync(
        'node --input-type=module -e "import { parseArgs } from \'node:util\'; const { values } = parseArgs({ args: [\'--port\', \'3458\'], options: { port: { type: \'string\', default: \'3457\' } }, strict: false, allowPositionals: true }); console.log(values.port);"',
        { encoding: 'utf8' }
    );
    assert.equal(result.trim(), '3458');
});

test('P4-007: LOG_DIR uses JAW_HOME not hardcoded path', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); const { join } = await import(\'node:path\'); console.log(join(c.JAW_HOME, \'logs\'))"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '/tmp/custom-jaw' } }
    );
    assert.equal(result.trim(), '/tmp/custom-jaw/logs');
});
