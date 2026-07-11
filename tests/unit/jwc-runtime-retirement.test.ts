import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
}

test('Jaw chat JWC runtime modules and registry wiring are retired', () => {
    assert.equal(existsSync(join(ROOT, 'src/agent/jwc-runtime.ts')), false);
    assert.equal(existsSync(join(ROOT, 'src/agent/jwc-event-mapper.ts')), false);

    const spawn = read('src/agent/spawn.ts');
    const registry = read('src/cli/registry.ts');
    const liveRegistry = read('src/cli/registry-live.ts');
    const runtimeSettings = read('src/core/runtime-settings.ts');

    assert.doesNotMatch(spawn, /jwc-runtime|jawRuntime\.prompt|settleJwcTurn/);
    assert.doesNotMatch(registry, /\bjwc:\s*\{/);
    assert.doesNotMatch(liveRegistry, /discoverJwcAuthenticatedProviders|registry\['jwc'\]/);
    assert.doesNotMatch(runtimeSettings, /syncJwcConfigDefault|jaw:jwc-config|CLI_JAW_JWC_AGENT_DIR/);
});

test('stale JWC selections are rejected before the child-process spawn path', () => {
    const spawn = read('src/agent/spawn.ts');
    const guard = spawn.indexOf("if (cli === 'jwc')");
    const permissions = spawn.indexOf('const permissions =', guard);
    const childSpawn = spawn.indexOf('spawn(', guard);

    assert.ok(guard > 0, 'spawn must guard stale or explicit jwc selections');
    assert.ok(permissions > guard, 'guard must run before normal CLI option resolution');
    assert.ok(childSpawn > guard, 'guard must run before any later child spawn');
    assert.match(spawn.slice(guard, permissions), /code:\s*1/);
});

test('Code mode JWC boundary and external management command remain available', () => {
    const eventBus = read('src/core/event-bus.ts');
    const acpHost = read('src/code-mode/acp-host.ts');
    const command = read('bin/commands/jwc.ts');

    assert.match(eventBus, /\| 'jwc'/);
    assert.match(acpHost, /args:\s*\['--mode', 'acp'\]/);
    assert.match(command, /jaw jwc install/);
    assert.match(command, /jaw jwc doctor/);
    assert.match(command, /jaw jwc clean/);
});

test('legacy JWC labels remain renderable while status filters JWC from chat CLIs', () => {
    const statusRender = read('public/js/features/settings-cli-status-render.ts');
    const tuiHistoryFixture = read('tests/unit/tui-settings-input.test.ts');

    assert.match(statusRender, /RETIRED_CHAT_CLIS\s*=\s*new Set\(\['jwc'\]\)/);
    assert.match(statusRender, /SIDEBAR_HIDDEN_CLIS[^\n]*\.\.\.RETIRED_CHAT_CLIS/);
    assert.match(tuiHistoryFixture, /cli:\s*'jwc'/);
    assert.match(tuiHistoryFixture, /label:\s*'jwc'/);
});
