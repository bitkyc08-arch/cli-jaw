/**
 * Generates the messaging ChannelAdapter capability matrix inside
 * `structure/CAPABILITY_TRUTH_TABLE.md`.
 *
 *   node_modules/.bin/tsx scripts/generate-channel-capability-table.mts
 *   node_modules/.bin/tsx scripts/generate-channel-capability-table.mts --check
 *
 * Why a generator instead of a hand-kept table: the declaration in
 * `src/messaging/channel-capabilities.ts` is the only thing the runtime obeys, so
 * a hand-written doc can only ever be a second, quieter claim. `--check` is wired
 * into `gate:truth-table-fresh`, which makes doc drift a release failure rather
 * than a review-time nicety.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { allChannelCapabilities, CHANNEL_CAPABILITY_KEYS } from '../src/messaging/channel-capabilities.ts';
import type { ChannelCapabilities } from '../src/messaging/channel-capabilities.ts';
import type { MessengerChannel } from '../src/messaging/types.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TABLE_REL = 'structure/CAPABILITY_TRUTH_TABLE.md';
const SOURCE_REL = 'src/messaging/channel-capabilities.ts';
const ADAPTER_REL = 'src/messaging/channel-adapter.ts';
const CONFORMANCE_REL = 'tests/unit/channel-contract-conformance.test.ts';
const GENERATOR_REL = 'scripts/generate-channel-capability-table.mts';

const START = '<!-- BEGIN GENERATED: messaging-channel-capabilities -->';
const END = '<!-- END GENERATED: messaging-channel-capabilities -->';

/** Prose for each capability key. Keyed by the closed set, so adding a capability
 *  without describing it is a compile error rather than an empty documentation cell. */
const CAPABILITY_NOTES: Record<keyof ChannelCapabilities, string> = {
    sendText: '텍스트 전송',
    editText: '전송된 메시지 수정',
    deleteMessage: '전송된 메시지 삭제',
    reaction: '리액션 부착',
    typing: '입력 중 표시',
    fileUpload: '파일 업로드',
    voice: '음성 파일 전달 (녹음 UI 아님)',
    threads: '스레드 타겟팅',
    interactiveActions: '버튼 등 인터랙티브 액션',
    durableIngress: '프로세스 재시작 후에도 유지되는 inbound 중복 제거',
    replayableTransport: '미확인 프레임을 트랜스포트가 재전송',
    maxMessageChars: '단일 메시지 문자 상한 (chunker 상수)',
};

function cell(value: boolean | number): string {
    if (typeof value === 'number') return `\`${value.toLocaleString('en-US')}\``;
    return value ? '✅' : '❌';
}

function buildBlock(): string {
    const capabilities = allChannelCapabilities();
    const channels = Object.keys(capabilities) as MessengerChannel[];

    const lines: string[] = [];
    lines.push('<!-- 이 블록은 생성됩니다. 손으로 고치지 마세요. -->');
    lines.push(`<!-- 생성기: ${GENERATOR_REL} · 소스: ${SOURCE_REL} -->`);
    lines.push('');
    lines.push(`> **생성된 블록입니다 — 직접 수정하지 마세요.** \`${SOURCE_REL}\`의`);
    lines.push(`> 선언을 읽어 \`npm run docs:channel-capabilities\`가 다시 씁니다.`);
    lines.push(`> 손으로 고친 내용은 \`gate:truth-table-fresh\`에서 drift로 실패합니다.`);
    lines.push('');
    lines.push(`| Capability | ${channels.map((c) => c).join(' | ')} | 의미 |`);
    lines.push(`| --- | ${channels.map(() => '---').join(' | ')} | --- |`);
    for (const key of CHANNEL_CAPABILITY_KEYS) {
        const values = channels.map((channel) => cell(capabilities[channel][key]));
        lines.push(`| \`${key}\` | ${values.join(' | ')} | ${CAPABILITY_NOTES[key]} |`);
    }
    lines.push('');
    lines.push('출처와 검증 지점:');
    lines.push('');
    lines.push(`- 선언 (SoT): [\`${SOURCE_REL}\`](../${SOURCE_REL})`);
    lines.push(`- 어댑터 계약: [\`${ADAPTER_REL}\`](../${ADAPTER_REL})`);
    lines.push(`- conformance test: \`${CONFORMANCE_REL}\` — 이 스위트 통과가 \`true\` 선언의 유일한 근거`);
    lines.push(`- 생성기: [\`${GENERATOR_REL}\`](../${GENERATOR_REL}) (\`--check\`는 \`gate:truth-table-fresh\`가 실행)`);
    lines.push('');
    lines.push('`true`는 이 트리에서 오늘 호출 가능한 동작만을 뜻합니다. 벤더 SDK가 제공한다는');
    lines.push('사실은 근거가 아닙니다 — conformance test가 통과할 때만 선언을 올립니다.');
    return lines.join('\n');
}

type Located = {
    text: string;
    startIdx: number;
    endIdx: number;
    committed: string;
};

function locate(text: string): Located {
    const startIdx = text.indexOf(START);
    const endIdx = text.indexOf(END);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        throw new Error(
            `${TABLE_REL} is missing the generated block markers.\n` +
            `  expected: ${START}\n            ${END}`,
        );
    }
    return {
        text,
        startIdx,
        endIdx,
        committed: text.slice(startIdx + START.length, endIdx),
    };
}

/** First differing line, so a failing gate points at the row instead of dumping both blocks. */
function firstDifference(committed: string, expected: string): string {
    const a = committed.split('\n');
    const b = expected.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] === b[i]) continue;
        return [
            `  first difference at generated-block line ${i + 1}:`,
            `    committed: ${a[i] === undefined ? '(line missing)' : JSON.stringify(a[i])}`,
            `    expected:  ${b[i] === undefined ? '(line missing)' : JSON.stringify(b[i])}`,
        ].join('\n');
    }
    return '  blocks differ in trailing bytes only';
}

function main(): number {
    const check = process.argv.includes('--check');
    const abs = path.join(repoRoot, TABLE_REL);
    const original = fs.readFileSync(abs, 'utf8');
    const located = locate(original);
    const expected = `\n${buildBlock()}\n`;

    if (check) {
        if (located.committed === expected) {
            console.log(`[ok] ${TABLE_REL} messaging capability matrix matches ${SOURCE_REL}`);
            return 0;
        }
        console.error(
            `[drift] ${TABLE_REL} messaging capability matrix does not match ${SOURCE_REL}.\n` +
            `${firstDifference(located.committed, expected)}\n` +
            `  fix: npm run docs:channel-capabilities`,
        );
        return 1;
    }

    if (located.committed === expected) {
        console.log(`[unchanged] ${TABLE_REL}`);
        return 0;
    }
    const next = original.slice(0, located.startIdx + START.length) + expected + original.slice(located.endIdx);
    fs.writeFileSync(abs, next);
    console.log(`[written] ${TABLE_REL} messaging capability matrix regenerated from ${SOURCE_REL}`);
    return 0;
}

try {
    process.exit(main());
} catch (err) {
    console.error(`[error] ${(err as Error).message}`);
    process.exit(1);
}
