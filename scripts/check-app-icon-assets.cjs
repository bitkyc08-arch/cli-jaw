#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function checkExists(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} missing: ${filePath}`);
  }
}

function checkPng(filePath, label) {
  checkExists(filePath, label);
  const bytes = readFileSync(filePath);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) {
    fail(`${label} is not a PNG: ${filePath}`);
  }
  const chunkType = bytes.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    fail(`${label} missing IHDR chunk: ${filePath}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validColorTypes = new Set([0, 2, 3, 4, 6]);
  if (width <= 0 || height <= 0) {
    fail(`${label} has invalid dimensions: ${filePath}`);
  }
  if (!validColorTypes.has(colorType)) {
    fail(`${label} has invalid PNG color type ${colorType}: ${filePath}`);
  }
  if (bitDepth <= 0) {
    fail(`${label} has invalid bit depth ${bitDepth}: ${filePath}`);
  }
  return { width, height, bitDepth, colorType };
}

function checkIcns(filePath, label) {
  checkExists(filePath, label);
  const bytes = readFileSync(filePath);
  if (bytes.length < 8 || bytes.subarray(0, 4).toString('ascii') !== 'icns') {
    fail(`${label} is not an ICNS file: ${filePath}`);
  }
}

const root = resolve(process.cwd());
const pngs = [
  ['electron/build/icon.png', 'Electron app PNG icon'],
  ['public/icons/icon-192.png', 'PWA normal 192 icon'],
  ['public/icons/icon-512.png', 'PWA normal 512 icon'],
  ['public/icons/icon-512-maskable.png', 'PWA maskable 512 icon'],
];

for (const [file, label] of pngs) {
  checkPng(join(root, file), label);
}
checkIcns(join(root, 'electron/build/icon.icns'), 'macOS app ICNS icon');

const builder = readFileSync(join(root, 'electron/electron-builder.yml'), 'utf8');
if (/\bwin:\s*(?:\n\s+[^\n]*)*\n\s+icon:\s*build\/icon\.ico\b/m.test(builder)) {
  checkExists(join(root, 'electron/build/icon.ico'), 'Windows app ICO icon');
}
if (/\blinux:\s*(?:\n\s+[^\n]*)*\n\s+icon:\s*build\/icons\b/m.test(builder)) {
  const linuxIcons = join(root, 'electron/build/icons');
  checkExists(linuxIcons, 'Linux app icon directory');
  const files = readdirSync(linuxIcons).filter(file => file.endsWith('.png'));
  if (files.length === 0) {
    fail(`Linux app icon directory has no PNG icons: ${linuxIcons}`);
  }
}

console.log('[app-icon-assets] OK');
