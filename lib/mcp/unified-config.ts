/**
 * lib/mcp/unified-config.ts
 * Load, save, import, and initialize unified MCP config.
 * Source of truth: ~/.cli-jaw/mcp.json
 */
import fs from 'fs';
import { join } from 'path';
import { JAW_HOME } from './skills-utils.js';

const MCP_PATH = join(JAW_HOME, 'mcp.json');

type McpServerConfig = {
    command: string;
    args?: string[];
    env?: Record<string, unknown>;
};

type UnifiedMcpConfig = {
    servers: Record<string, McpServerConfig>;
};

// ─── Default MCP servers ───────────────────────────
const DEFAULT_MCP_SERVERS = {
    context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
    },
};

// ─── Load / Save unified config ────────────────────

export function loadUnifiedMcp() {
    try {
        return JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
    } catch {
        return { servers: {} };
    }
}

export function saveUnifiedMcp(config: UnifiedMcpConfig) {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(MCP_PATH, JSON.stringify(config, null, 4) + '\n');
}

// ─── Import from existing configs ──────────────────

/** Import from Claude-style .mcp.json into unified format */
export function importFromClaudeMcp(filePath: string) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const input = raw as { mcpServers?: Record<string, Partial<McpServerConfig>> };
        const servers: Record<string, McpServerConfig> = {};
        for (const [name, srv] of Object.entries(input.mcpServers || {})) {
            servers[name] = {
                command: typeof srv.command === 'string' ? srv.command : '',
                args: srv.args || [],
                ...(srv.env && Object.keys(srv.env).length ? { env: srv.env } : {}),
            };
        }
        return { servers };
    } catch { return { servers: {} }; }
}

// ─── Init: first-time setup ────────────────────────

/**
 * Initialize MCP config if missing.
 * If workingDir has .mcp.json, import and merge with defaults.
 * Otherwise, create config with default servers (context7).
 */
export function initMcpConfig(workingDir: string) {
    if (fs.existsSync(MCP_PATH)) {
        console.log(`[mcp-sync] unified config exists: ${MCP_PATH}`);
        return loadUnifiedMcp();
    }

    let servers = { ...DEFAULT_MCP_SERVERS };

    // Try importing from existing .mcp.json, merge with defaults
    const claudePath = join(workingDir, '.mcp.json');
    if (fs.existsSync(claudePath)) {
        console.log(`[mcp-sync] importing from ${claudePath}`);
        const imported = importFromClaudeMcp(claudePath);
        servers = { ...servers, ...(imported.servers || {}) };
    }

    const config = { servers };
    saveUnifiedMcp(config);
    console.log(`[mcp-sync] initialized with ${Object.keys(servers).length} servers: ${Object.keys(servers).join(', ')}`);
    return config;
}
