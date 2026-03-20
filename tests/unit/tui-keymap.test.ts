import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyAction } from '../../src/cli/tui/keymap.ts';

test('classifyKeyAction detects navigation escape sequences', () => {
    assert.equal(classifyKeyAction('\x1b[A'), 'arrow-up');
    assert.equal(classifyKeyAction('\x1bOB'), 'arrow-down');
    assert.equal(classifyKeyAction('\x1b[5~'), 'page-up');
    assert.equal(classifyKeyAction('\x1b[6~'), 'page-down');
    assert.equal(classifyKeyAction('\x1b[H'), 'home');
    assert.equal(classifyKeyAction('\x1bOF'), 'end');
});

test('classifyKeyAction detects enter family and control keys', () => {
    assert.equal(classifyKeyAction('\x1b\n'), 'option-enter');
    assert.equal(classifyKeyAction('\r'), 'enter');
    assert.equal(classifyKeyAction('\x7f'), 'backspace');
    assert.equal(classifyKeyAction('\x03'), 'ctrl-c');
    assert.equal(classifyKeyAction('\x15'), 'ctrl-u');
});

test('classifyKeyAction detects printable input and unknown keys', () => {
    assert.equal(classifyKeyAction('a'), 'printable');
    assert.equal(classifyKeyAction('가'), 'printable');
    assert.equal(classifyKeyAction('\x00'), 'other');
});
