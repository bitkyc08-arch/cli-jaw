export function preprocessMermaid(code: string): string {
    let result = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/;\s*$/gm, '');
    if (/^\s*(flowchart|graph)\b/m.test(result)) result = normalizeFlowchartNodeIds(result);
    return result;
}

const RESERVED_NODE_IDS = new Set(['end', 'default', 'class', 'style']);

function normalizeFlowchartNodeIds(code: string): string {
    return code.replace(/(^|[\s;])([A-Za-z_][\w/.:-]*)(?=\s*(?:\[|\(|\{|>))/gm, (match, prefix: string, id: string) => {
        let normalized = id.replace(/[/.:-]+/g, '_');
        if (RESERVED_NODE_IDS.has(normalized.toLowerCase())) normalized = `node_${normalized}`;
        return normalized === id ? match : `${prefix}${normalized}`;
    });
}

export function sanitizeMermaidForRetry(code: string): string | null {
    if (!/^\s*(flowchart|graph)\b/m.test(code)) return null;
    return code.split('\n').map((line) => {
        let result = ''; let index = 0;
        while (index < line.length) {
            const match = line.slice(index).match(/^([A-Za-z_]\w*)\[(?!")/);
            if (!match) { result += line[index]; index += 1; continue; }
            result += `${match[1]}["`; index += match[0].length;
            let depth = 1; let label = '';
            while (index < line.length && depth > 0) {
                const character = line[index];
                if (character === '[') depth += 1;
                else if (character === ']') depth -= 1;
                if (depth > 0) label += character;
                index += 1;
            }
            result += `${label.replace(/"/g, '#quot;')}"]`;
        }
        return result;
    }).join('\n');
}
