import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\].*?\x07|\x1b_.*?\x1b\\/g;
function isWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3040 && cp <= 0x33BF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0x4E00 && cp <= 0xA4CF) || (cp >= 0xA960 && cp <= 0xA97C) ||
        (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xD7B0 && cp <= 0xD7FF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x20000 && cp <= 0x2FA1F);
}
function stringWidth(str) {
    const s = str.replace(ANSI_RE, '');
    let w = 0;
    for (const ch of s) { const cp = ch.codePointAt(0); if (cp === undefined || cp < 0x20) continue; w += isWide(cp) ? 2 : 1; }
    return w;
}
function stripANSI(str) { return str.replace(ANSI_RE, ''); }
function hash(data, seed) {
    const h = createHash('md5');
    if (seed !== undefined) h.update(String(seed));
    h.update(typeof data === 'string' ? data : Buffer.from(data));
    return h.digest().readUInt32LE(0);
}
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

function hexToRgb(hex) {
    const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
    if (!m) return null;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function bunColor(color, format) {
    if (!color) return null;
    if (format === 'ansi-16m' || format === 'ansi') {
        const rgb = hexToRgb(color);
        if (rgb) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
        if (color.startsWith('\x1b[')) return color;
        return null;
    }
    if (format === 'ansi-256') {
        const rgb = hexToRgb(color);
        if (rgb) {
            const idx = 16 + 36 * Math.round(rgb[0] / 255 * 5) + 6 * Math.round(rgb[1] / 255 * 5) + Math.round(rgb[2] / 255 * 5);
            return `\x1b[38;5;${idx}m`;
        }
        return null;
    }
    if (format === 'rgb') {
        const rgb = hexToRgb(color);
        if (rgb) return { r: rgb[0], g: rgb[1], b: rgb[2] };
        return null;
    }
    return color;
}

function bunFile(path) {
    return {
        text: () => readFile(path, 'utf-8'),
        json: async () => JSON.parse(await readFile(path, 'utf-8')),
        exists: () => existsSync(path),
        size: 0,
    };
}

async function bunSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function bunWrite() { return Promise.resolve(0); }

function bunPlugin() {}
function bunSpawn() { return { exitCode: Promise.resolve(0), stdout: { toString() { return ''; } }, stderr: { toString() { return ''; } }, kill() {} }; }
// #383: the old body called require() inside ESM (ReferenceError swallowed by
// the catch -> null on EVERY platform) and shelled POSIX `which`, absent on
// stock Windows. execFileSync with argv avoids both plus shell interpolation.
function bunWhich(cmd) { try { const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf-8' }); const first = out.split(/\r?\n/).find(l => l.trim()); return first ? first.trim() : null; } catch { return null; } }

if (typeof globalThis.Bun === 'undefined') {
    globalThis.Bun = { env: process.env, stringWidth, stripANSI, hash, color: bunColor, file: bunFile, sleep: bunSleep, write: bunWrite, plugin: bunPlugin, spawn: bunSpawn, which: bunWhich, version: '0.0.0-node-shim', main: '', argv: process.argv, cwd: () => process.cwd() };
}
