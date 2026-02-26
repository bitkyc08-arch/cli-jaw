import test from 'node:test';
import assert from 'node:assert/strict';
import { fixCjkPunctuationBoundary } from '../../public/js/cjk-fix.ts';
import { markdownToTelegramHtml } from '../../src/telegram/forwarder.ts';

// ── Core failure case: punctuation + ** + CJK ──

test(')**CJK gets ZWSP between punctuation and **', () => {
    const result = fixCjkPunctuationBoundary('**2월 26일(목요일)**이에요');
    // ZWSP inserted between ) and **: )\u200B**
    assert.ok(result.includes(')\u200B**이에요'), `Got: ${JSON.stringify(result)}`);
});

test('multiple )**CJK patterns all get ZWSP', () => {
    const result = fixCjkPunctuationBoundary('**(A)**가 **(B)**나');
    assert.ok(result.includes(')\u200B**가'));
    assert.ok(result.includes(')\u200B**나'));
});

test('.**CJK gets ZWSP', () => {
    const result = fixCjkPunctuationBoundary('**끝.**다음');
    assert.ok(result.includes('.\u200B**다음'));
});

// ── Cases that should NOT be modified ──

test('**텍스트**CJK without punctuation is untouched', () => {
    const result = fixCjkPunctuationBoundary('**안녕**하세요');
    assert.equal(result, '**안녕**하세요');  // 녕 is not punctuation → no ZWSP
});

test('** followed by space is untouched', () => {
    const result = fixCjkPunctuationBoundary('**끝** 다음');
    assert.equal(result, '**끝** 다음');
});

test('** followed by punctuation is untouched', () => {
    const result = fixCjkPunctuationBoundary('**끝**,뒤');
    assert.equal(result, '**끝**,뒤');
});

test('text without asterisks passes through unchanged', () => {
    const input = '그냥 일반 텍스트입니다';
    assert.equal(fixCjkPunctuationBoundary(input), input);
});

// ── Fenced code block preservation ──

test('fenced code block content is not modified', () => {
    const input = '```\n)**한글\n```';
    assert.equal(fixCjkPunctuationBoundary(input), input);
});

test('inline code content is not modified', () => {
    const input = '`)**한글`';
    assert.equal(fixCjkPunctuationBoundary(input), input);
});

test('code block preserved but surrounding text is fixed', () => {
    const input = '```\n)**코드\n```\n그리고 **(괄호)**밖';
    const result = fixCjkPunctuationBoundary(input);
    assert.ok(result.includes('```\n)**코드\n```'));   // code untouched
    assert.ok(result.includes(')\u200B**밖'));           // outside text fixed
});

// ── *** (bold+italic) should not be broken ──

test('*** sequence is not split by ZWSP', () => {
    const result = fixCjkPunctuationBoundary('***강조***텍스트');
    // * is excluded from punctuation match → no ZWSP inserted
    assert.ok(!result.includes('\u200B'), `Unexpected ZWSP in: ${JSON.stringify(result)}`);
});

// ── Telegram markdown regex (already works with CJK) ──

test('telegram bold adjacent CJK renders correctly', () => {
    assert.ok(markdownToTelegramHtml('**안녕**하세요').includes('<b>안녕</b>하세요'));
});

test('telegram bold with paren before CJK renders correctly', () => {
    assert.ok(markdownToTelegramHtml('**2월 26일(목요일)**이에요').includes('<b>2월 26일(목요일)</b>이에요'));
});

test('telegram italic adjacent CJK', () => {
    assert.ok(markdownToTelegramHtml('*기울임*바로뒤').includes('<i>기울임</i>바로뒤'));
});
