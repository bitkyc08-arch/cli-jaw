import fs from 'node:fs';
import xterm from '@xterm/xterm';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bytes = Buffer.from(input.data, 'base64');
const sizes = input.sizes;
const terminal = new xterm.Terminal({ cols: sizes[0].columns, rows: sizes[0].rows, allowProposedApi: true });
try {
    for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        if (i) terminal.resize(size.columns, size.rows);
        const end = sizes[i + 1]?.offset ?? bytes.length;
        await new Promise(resolve => terminal.write(bytes.subarray(size.offset, end), resolve));
    }
    const buffer = terminal.buffer.active;
    console.log(JSON.stringify({ rows: Array.from({ length: terminal.rows }, (_, i) =>
        buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? ''),
        cursor: { x: buffer.cursorX, y: buffer.cursorY } }));
} finally { terminal.dispose(); }
