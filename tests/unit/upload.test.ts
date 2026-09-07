// #42: upload.ts unit tests — saveUpload filename handling
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    saveUpload,
    buildMediaPromptMany,
    TELEGRAM_DOWNLOAD_LIMITS,
    TELEGRAM_DOWNLOAD_TIMEOUT_MS,
    TELEGRAM_METADATA_MAX_BYTES,
    __test__,
} from '../../lib/upload.ts';

const tmpDir = () => {
    const d = path.join(os.tmpdir(), `upload-test-${Date.now()}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

test('UP-001: saveUpload preserves .ipynb extension', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('{}'), 'notebook.ipynb');
    assert.ok(p.endsWith('.ipynb'));
    fs.rmSync(dir, { recursive: true });
});

test('UP-002: saveUpload preserves Korean filename stem', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('data'), '한글파일.xlsx');
    assert.ok(path.basename(p).includes('한글파일'), `expected Korean stem in: ${p}`);
    fs.rmSync(dir, { recursive: true });
});

test('UP-003: saveUpload falls back to "file" on empty stem', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('x'), '!!!.bin');
    assert.ok(path.basename(p).includes('file'), `expected 'file' fallback in: ${p}`);
    fs.rmSync(dir, { recursive: true });
});

test('UP-004: saveUpload defaults to .bin when no extension', () => {
    const dir = tmpDir();
    const p = saveUpload(dir, Buffer.from('x'), 'noext');
    assert.ok(p.endsWith('.bin'));
    fs.rmSync(dir, { recursive: true });
});

test('UP-005: saveUpload generates unique names for same original filename', () => {
    const dir = tmpDir();
    const a = saveUpload(dir, Buffer.from('a'), 'same.pdf');
    const b = saveUpload(dir, Buffer.from('b'), 'same.pdf');
    assert.notEqual(path.basename(a), path.basename(b));
    fs.rmSync(dir, { recursive: true });
});

test('UP-006: buildMediaPromptMany falls back to single-file prompt for one path', () => {
    const prompt = buildMediaPromptMany(['/tmp/a.pdf'], 'caption');
    assert.match(prompt, /사용자가 파일을 보냈습니다/);
});

test('UP-007: buildMediaPromptMany includes all file paths for multi-file input', () => {
    const prompt = buildMediaPromptMany(['/tmp/a.pdf', '/tmp/b.pdf'], 'compare');
    assert.match(prompt, /파일 2개/);
    // 각 항목에 종류 라벨이 붙는다.
    assert.match(prompt, /1\. \[파일\] \/tmp\/a\.pdf/);
    assert.match(prompt, /2\. \[파일\] \/tmp\/b\.pdf/);
    assert.match(prompt, /사용자 메시지: compare/);
});

test('UP-007a: multi-image prompt keeps image semantics', () => {
    // 회귀 근거: 2개 이상일 때 종류 판정을 잃어 에이전트가 PNG를 Read로 열려다
    // 실패했다 (프로덕션 jaw.db id=218).
    const prompt = buildMediaPromptMany(['/tmp/a.png', '/tmp/b.png'], '봐줘');
    assert.match(prompt, /이미지/);
    assert.match(prompt, /직접 보고/);
    assert.ok(prompt.includes('/tmp/a.png') && prompt.includes('/tmp/b.png'));
    assert.match(prompt, /사용자 메시지: 봐줘/);
});

test('UP-007b: mixed kinds label every entry', () => {
    const prompt = buildMediaPromptMany(['/tmp/a.png', '/tmp/b.pdf']);
    assert.match(prompt, /1\. \[이미지\] \/tmp\/a\.png/);
    assert.match(prompt, /2\. \[파일\] \/tmp\/b\.pdf/);
    assert.match(prompt, /이미지는 직접 보고 분석/);
});

test('UP-007c: video-only multi prompt uses the video instruction', () => {
    const prompt = buildMediaPromptMany(['/tmp/a.mp4', '/tmp/b.pdf']);
    assert.match(prompt, /1\. \[동영상\] \/tmp\/a\.mp4/);
    assert.match(prompt, /동영상 파일을 확인하고/);
    assert.doesNotMatch(prompt, /직접 보고/);
});

test('UP-008: Telegram download limits match inbound media ceilings', () => {
    assert.equal(TELEGRAM_DOWNLOAD_LIMITS.voice, 50 * 1024 * 1024);
    assert.equal(TELEGRAM_DOWNLOAD_LIMITS.photo, 10 * 1024 * 1024);
    assert.equal(TELEGRAM_DOWNLOAD_LIMITS.document, 50 * 1024 * 1024);
    assert.equal(TELEGRAM_DOWNLOAD_TIMEOUT_MS, 30_000);
    assert.equal(TELEGRAM_METADATA_MAX_BYTES, 1024 * 1024);
});

test('UP-009: Telegram download size precheck rejects oversized metadata', () => {
    assert.throws(
        () => __test__.assertTelegramDownloadSize(11 * 1024 * 1024, TELEGRAM_DOWNLOAD_LIMITS.photo, 'photo'),
        /Telegram photo too large/,
    );
    assert.doesNotThrow(
        () => __test__.assertTelegramDownloadSize(9 * 1024 * 1024, TELEGRAM_DOWNLOAD_LIMITS.photo, 'photo'),
    );
});

test('UP-010: downloadTelegramFile has bounded request contracts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/upload.ts'), 'utf8');
    assert.match(src, /status < 200 \|\| status >= 300/);
    assert.match(src, /req\.setTimeout\(timeoutMs/);
    assert.match(src, /total > maxBytes/);
    assert.match(src, /TELEGRAM_METADATA_MAX_BYTES/);
    assert.doesNotMatch(src, /Buffer\.concat\(chunks\)\s*,/);
});
