import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServicePath } from '../../src/core/runtime-path.ts';

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'server.ts');
const CONFIG = path.join(ROOT, 'src/core/config.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');
const LIFECYCLE = path.join(ROOT, 'src/agent/lifecycle-handler.ts');
const DB = path.join(ROOT, 'src/core/db.ts');
const LAUNCHD = path.join(ROOT, 'bin/commands/launchd.ts');
const SERVICE = path.join(ROOT, 'bin/commands/service.ts');

test('SRH-001: buildServicePath augments minimal PATH with common service-safe directories', () => {
    const built = buildServicePath('/usr/bin:/bin', []);
    assert.match(built, /\/usr\/local\/bin/);
    assert.match(built, /\/opt\/homebrew\/bin/);
    assert.match(built, /\/usr\/bin/);
});

test('SRH-002: buildServicePath discovers managed node bins from a custom home', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-path-'));
    const nvmBin = path.join(tmpHome, '.nvm', 'versions', 'node', 'v22.9.0', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });

    const built = buildServicePath('/usr/bin:/bin', [], tmpHome);
    assert.ok(
        built.split(path.delimiter).includes(nvmBin),
        'nvm-managed node bin should be included in service PATH',
    );
});

test('SRH-003: server clears stale employee sessions before heartbeat and seeds employees first', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const clearIdx = src.indexOf('clearAllEmployeeSessions.run()');
    const seedIdx = src.indexOf('const seeded = seedDefaultEmployees()');
    const heartbeatIdx = src.indexOf('startHeartbeat();');

    assert.ok(clearIdx >= 0, 'startup must clear employee_sessions');
    assert.ok(seedIdx >= 0, 'startup must seed default employees');
    assert.ok(heartbeatIdx >= 0, 'startup must start heartbeat');
    assert.ok(seedIdx < heartbeatIdx, 'heartbeat must start after employees are seeded');
});

test('SRH-004: service installers use shared service PATH builder instead of raw process.env.PATH', () => {
    const launchdSrc = fs.readFileSync(LAUNCHD, 'utf8');
    const serviceSrc = fs.readFileSync(SERVICE, 'utf8');

    assert.match(launchdSrc, /buildServicePath\(process\.env\.PATH \|\| ''/);
    assert.match(serviceSrc, /buildServicePath\(process\.env\.PATH \|\| ''/);
    assert.doesNotMatch(launchdSrc, /<string>\$\{xmlEsc\(process\.env\.PATH \|\| ''\)\}<\/string>/);
    assert.doesNotMatch(serviceSrc, /Environment="PATH=\$\{process\.env\.PATH \|\| '\/usr\/local\/bin:\/usr\/bin:\/bin'\}"/);
});

test('SRH-005: spawn path and detectCli logic use service-safe PATH handling', () => {
    const spawnSrc = fs.readFileSync(SPAWN, 'utf8');
    const configSrc = fs.readFileSync(CONFIG, 'utf8');
    const lifecycleSrc = fs.readFileSync(LIFECYCLE, 'utf8');
    const dbSrc = fs.readFileSync(DB, 'utf8');

    assert.match(spawnSrc, /env\.PATH = buildServicePath\(env\.PATH \|\| ''\)/);
    assert.match(spawnSrc, /const spawnCommand = process\.platform === 'win32' \? cli : \(detected\.path \|\| cli\)/);
    assert.match(spawnSrc, /clearEmployeeSession\.run\(opts\.agentId\)/);
    assert.match(lifecycleSrc, /clearEmployeeSession\.run\(opts\.agentId\)/);
    assert.match(dbSrc, /export const clearEmployeeSession = db\.prepare\('DELETE FROM employee_sessions WHERE employee_id = \?'\)/);
    assert.match(configSrc, /PATH: buildServicePath\(process\.env\.PATH \|\| ''\)/);
});

test('SRH-006: loadSettings warns and backs up unreadable settings instead of silently overwriting them', () => {
    const src = fs.readFileSync(CONFIG, 'utf8');
    assert.match(src, /if \(err\?\.code === 'ENOENT'\)/);
    assert.match(src, /console\.warn\(`\[jaw:settings\] failed to load/);
    assert.match(src, /copyFileSync\(SETTINGS_PATH, backupPath\)/);
    assert.doesNotMatch(src, /\} catch \(error\) \{[\s\S]*saveSettings\(next\)[\s\S]*copyFileSync/s);
});
