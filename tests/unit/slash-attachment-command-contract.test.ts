import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chatSource = readFileSync(new URL('../../public/js/features/chat.ts', import.meta.url), 'utf8');
// /api/command lives in routes/command.ts since the Phase 2 extraction.
const serverSource = readFileSync(new URL('../../src/routes/command.ts', import.meta.url), 'utf8');

test('SAC-001: chat detects slash commands independently from attached files', () => {
    assert.match(
        chatSource,
        /const isSlashCommand = text\.startsWith\('\/'\) && !isFilePath;/,
        'slash detection should not require state.attachedFiles.length === 0',
    );
    assert.doesNotMatch(
        chatSource,
        /text\.startsWith\('\/'\) && !state\.attachedFiles\.length && !isFilePath/,
        'attached files must not block slash command intent detection',
    );
});

test('SAC-002: slash commands with attachments execute through command response handling', () => {
    assert.match(chatSource, /function buildSlashCommandAttachmentText\(text: string, paths: string\[\]\): string/);
    assert.match(chatSource, /\$\{text\}\\n\\n\$\{fileContext\}/);
    assert.match(
        chatSource,
        /if \(isSlashCommand\) \{[\s\S]*const commandText = buildSlashCommandAttachmentText\(text, paths\);[\s\S]*await postSlashCommand\(commandText\);[\s\S]*handleSlashCommandResponse\(commandText, commandResponse/s,
    );
    assert.match(
        chatSource,
        /handleSlashCommandResponse\(commandText, commandResponse, async \(\) => \{[\s\S]*apiJson\('\/api\/message', 'POST', withCurrentSessionBody\(\{ prompt \}\)\);[\s\S]*\}\);/s,
        'not_command fallback should preserve normal attachment message submission',
    );
});

test('SAC-003: normal attachment messages still use /api/message', () => {
    assert.match(chatSource, /const prompt = buildAttachmentPrompt\(paths, text\);/);
    assert.match(
        chatSource,
        /if \(isSlashCommand\) \{[\s\S]*return;[\s\S]*\}\s*await apiJson\('\/api\/message', 'POST', withCurrentSessionBody\(\{ prompt \}\)\);/s,
    );
});

test('SAC-004: web command route accepts attachment-sized command text', () => {
    assert.match(serverSource, /const WEB_COMMAND_TEXT_LIMIT = 30_000;/);
    assert.match(serverSource, /\.slice\(0, WEB_COMMAND_TEXT_LIMIT\)/);
    assert.doesNotMatch(
        serverSource,
        /const text = String\(req\.body\?\.text \|\| ''\)\.trim\(\)\.slice\(0, 500\)/,
        '/api/command must not keep the old 500-char truncation',
    );
});

test('SAC-005: no-attachment slash commands keep the canonical command response path', () => {
    assert.match(
        chatSource,
        /if \(isSlashCommand && !state\.attachedFiles\.length\) \{[\s\S]*await handleSlashCommandResponse\(text, await postSlashCommand\(text\)\);[\s\S]*return;/s,
        'plain slash commands should still use /api/command response handling and return before normal message submission',
    );
});
