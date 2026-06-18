import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCodeCommands, normalizeCodeCommand, normalizeCodeCommands } from '../../public/manager/src/code/code-types.ts';

test('code command registry infers JWC popup-capable command metadata', () => {
    const model = normalizeCodeCommand({ name: 'model', description: 'Select model', input: { hint: '<model>' } });
    assert.ok(model);
    assert.equal(model.name, 'model');
    assert.equal(model.displayName, '/model');
    assert.equal(model.category, 'model');
    assert.equal(model.actionType, 'popup');
    assert.equal(model.popupKind, 'model');
    assert.equal(model.source, 'jwc-builtin');
    assert.equal(model.inputHint, '<model>');

    const provider = normalizeCodeCommand({ name: '/provider', description: 'Provider setup' });
    assert.ok(provider);
    assert.equal(provider.name, 'provider');
    assert.equal(provider.category, 'provider');
    assert.equal(provider.actionType, 'popup');
    assert.equal(provider.popupKind, 'provider');
});

test('code command registry keeps unknown JWC commands as pass-through', () => {
    const command = normalizeCodeCommand({
        name: 'project-custom',
        description: 'Project command',
        source: 'file',
    });
    assert.ok(command);
    assert.equal(command.category, 'unknown');
    assert.equal(command.actionType, 'pass-through');
    assert.equal(command.source, 'jwc-file');
});

test('code command registry ignores malformed rows and de-dupes by name', () => {
    const commands = normalizeCodeCommands([
        null,
        {},
        { name: 'model', description: 'first' },
        { name: '/model', description: 'second' },
        { name: 'goal' },
    ]);
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.description, 'first');
    assert.equal(commands[1]?.name, 'goal');
    assert.equal(commands[1]?.category, 'workflow');
});

test('code command registry preserves JWC disabled command reasons', () => {
    const command = normalizeCodeCommand({
        name: '/model',
        description: 'Select model',
        supported: false,
        disabledReason: 'Provider auth required',
    });

    assert.equal(command?.actionType, 'unsupported');
    assert.equal(command?.disabledReason, 'Provider auth required');
    assert.equal(command?.popupKind, 'model');
});

test('code command filtering strips slash and prioritizes prefix matches', () => {
    const commands = normalizeCodeCommands([
        { name: 'provider', description: 'Provider setup' },
        { name: 'model', description: 'Choose model' },
        { name: 'custom-model-report', description: 'Report models' },
    ]);

    assert.deepEqual(filterCodeCommands(commands, '/mo').map(command => command.name), ['model', 'custom-model-report']);
    assert.deepEqual(filterCodeCommands(commands, '/provider ').map(command => command.name), ['provider']);
    assert.deepEqual(filterCodeCommands(commands, '/setup').map(command => command.name), ['provider']);
});
