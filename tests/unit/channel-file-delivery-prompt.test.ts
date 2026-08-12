import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const promptPaths = [
    path.resolve(here, '../../src/prompt/templates/a1-system.md'),
    path.resolve(here, '../../src/prompt/templates/employee.md'),
];

function channelSendExamples(source: string): Array<Record<string, any>> {
    const sectionStart = source.indexOf('## Channel File Delivery');
    assert.ok(sectionStart >= 0, 'prompt is missing the Channel File Delivery section');
    const nextSection = source.indexOf('\n## ', sectionStart + 3);
    const section = source.slice(sectionStart, nextSection < 0 ? undefined : nextSection);
    const examples: Array<Record<string, any>> = [];
    for (const match of section.matchAll(/(?:```json\s*\n([\s\S]*?)```|`(\{"(?:channel|type)"[^\n`]+\})`)/gi)) {
        try {
            const value = JSON.parse(match[1] ?? match[2]!);
            if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string') {
                examples.push(value);
            }
        } catch {
            // Other prompt sections may intentionally show partial JSON. Only complete
            // executable channel-send examples form this contract.
        }
    }
    return examples;
}

async function exercisePromptExamples(promptPath: string) {
    const source = fs.readFileSync(promptPath, 'utf8');
    const examples = channelSendExamples(source);
    const explicit = examples.find(value => value.channel === 'slack' && value.target?.targetId && value.target?.threadId);
    const implicit = examples.find(value => value.type && value.target == null && value.chat_id == null && value.chatId == null);
    assert.ok(explicit, `${path.basename(promptPath)} needs an executable Slack target/thread JSON example`);
    assert.ok(implicit, `${path.basename(promptPath)} needs an executable current-conversation JSON example`);

    const { settings } = await import('../../src/core/config.js');
    const { normalizeChannelSendRequest, registerSendTransport, sendChannelOutput } = await import('../../src/messaging/send.js');
    const { clearTargetState, setLastActiveTarget } = await import('../../src/messaging/runtime.js');
    const previousSlack = settings.slack;
    const previousChannel = settings.channel;
    const previousMessaging = settings.messaging;
    const previousProjectDirs = settings.projectDirs;
    const sent: Array<Record<string, any>> = [];
    const fixtureDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-channel-prompt-')));
    const fixturePath = path.join(fixtureDir, 'prompt-example.txt');
    fs.writeFileSync(fixturePath, 'prompt contract fixture');
    const executable = (example: Record<string, any>) => ({
        ...example,
        ...(typeof example.file_path === 'string' ? { file_path: fixturePath } : {}),
        ...(typeof example.filePath === 'string' ? { filePath: fixturePath } : {}),
    });
    try {
        clearTargetState();
        settings.channel = 'slack';
        settings.slack = { ...(settings.slack || {}), channelIds: [String(explicit.target.targetId)] };
        settings.projectDirs = [fixtureDir];
        registerSendTransport('slack', async req => {
            sent.push(structuredClone(req));
            return { ok: true };
        });

        const explicitResult = await sendChannelOutput(normalizeChannelSendRequest(executable(explicit)));
        assert.equal(explicitResult.ok, true);
        assert.equal(sent.at(-1)?.target?.targetId, explicit.target.targetId);
        assert.equal(sent.at(-1)?.target?.threadId, explicit.target.threadId);

        const current = {
            channel: 'slack' as const,
            targetKind: 'channel' as const,
            peerKind: 'channel' as const,
            targetId: 'C_CURRENT',
            threadId: '1710000000.000100',
        };
        settings.slack = { ...(settings.slack || {}), channelIds: [] };
        setLastActiveTarget('slack', current);
        const implicitResult = await sendChannelOutput(normalizeChannelSendRequest(executable(implicit)));
        assert.equal(implicitResult.ok, true);
        assert.deepEqual(sent.at(-1)?.target, current, 'omitting target must preserve the inbound parent thread');
    } finally {
        clearTargetState();
        settings.slack = previousSlack;
        settings.channel = previousChannel;
        settings.messaging = previousMessaging;
        settings.projectDirs = previousProjectDirs;
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
}

for (const promptPath of promptPaths) {
    test(`${path.basename(promptPath)} channel delivery JSON examples execute through normalization and send`, async () => {
        await exercisePromptExamples(promptPath);
    });
}
