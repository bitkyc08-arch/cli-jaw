/**
 * lib/mcp/format-converters.ts
 * CLI format conversions (Claude/Codex/Gemini/OpenCode/Copilot/Antigravity)
 * and patchJsonFile helper.
 */
import fs from 'fs';
import os from 'os';
import { join, dirname } from 'path';

type McpServerConfig = {
    command?: string;
    args?: string[];
    env?: Record<string, unknown>;
};

type UnifiedMcpConfig = {
    servers?: Record<string, McpServerConfig>;
};

function getServers(config: UnifiedMcpConfig): Record<string, McpServerConfig> {
    return config.servers ?? {};
}

// ─── Convert to CLI-specific formats ───────────────

/** → Claude Code / Gemini CLI format (.mcp.json / settings.json mcpServers block) */
export function toClaudeMcp(config: UnifiedMcpConfig) {
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, srv] of Object.entries(getServers(config))) {
        mcpServers[name] = { args: srv.args || [] };
        if (srv.command !== undefined) mcpServers[name]!.command = srv.command;
        if (srv.env && Object.keys(srv.env).length) mcpServers[name]!.env = srv.env;
    }
    return { mcpServers };
}

/** → Codex config.toml MCP section string */
export function toCodexToml(config: UnifiedMcpConfig) {
    let toml = '';
    for (const [name, srv] of Object.entries(getServers(config))) {
        toml += `[mcp_servers.${name}]\n`;
        toml += `command = "${srv.command || ''}"\n`;
        toml += `args = ${JSON.stringify(srv.args || [])}\n`;
        if (srv.env && Object.keys(srv.env).length) {
            toml += `[mcp_servers.${name}.env]\n`;
            for (const [k, v] of Object.entries(srv.env)) {
                toml += `${k} = "${String(v)}"\n`;
            }
        }
        toml += '\n';
    }
    return toml;
}

/** → OpenCode opencode.json mcp block */
export function toOpenCodeMcp(config: UnifiedMcpConfig) {
    const mcp: Record<string, { type: 'local'; command: string[]; environment?: Record<string, unknown> }> = {};
    for (const [name, srv] of Object.entries(getServers(config))) {
        mcp[name] = {
            type: 'local',
            command: [srv.command || '', ...(srv.args || [])],
        };
        if (srv.env && Object.keys(srv.env).length) mcp[name]!.environment = srv.env;
    }
    return mcp;
}

// ─── Patch helpers ─────────────────────────────────

/** Replace only [mcp_servers.*] sections in existing TOML, keep everything else */
export function patchCodexToml(existingToml: string, newMcpToml: string) {
    const lines = existingToml.split('\n');
    const output = [];
    let inMcp = false;

    for (const line of lines) {
        if (/^\[mcp_servers\./.test(line)) {
            inMcp = true;
            continue;
        }
        if (inMcp && /^\[/.test(line) && !/^\[mcp_servers\./.test(line)) {
            inMcp = false;
        }
        if (!inMcp) output.push(line);
    }

    // Remove trailing blank lines before appending MCP section
    while (output.length && output[output.length - 1]!.trim() === '') output.pop();
    return output.join('\n') + '\n\n' + newMcpToml;
}

/** Patch JSON file — merge a block into existing JSON without losing other keys */
function patchJsonFile(filePath: string, patchObj: Record<string, unknown>) {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { }
    const merged = { ...existing, ...patchObj };
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 4) + '\n');
}

// ─── Sync to all targets ──────────────────────────

/**
 * Sync unified MCP config to all CLI config files (global paths only).
 * @param {Object} config - Unified MCP config { servers: {...} }
 */
export function syncToAll(config: UnifiedMcpConfig) {
    const results = { claude: false, codex: false, gemini: false, opencode: false, copilot: false, antigravity: false };

    // 1. Claude Code: ~/.mcp.json (global)
    try {
        const claudePath = join(os.homedir(), '.mcp.json');
        const claudeData = toClaudeMcp(config);
        // Merge with existing (keep other keys if any)
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = claudeData.mcpServers;
        fs.writeFileSync(claudePath, JSON.stringify(existing, null, 4) + '\n');
        results.claude = true;
        console.log(`[mcp-sync] ✅ Claude: ${claudePath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Claude:`, (e as Error).message); }

    // 2. Codex: ~/.codex/config.toml
    try {
        const codexPath = join(os.homedir(), '.codex', 'config.toml');
        if (fs.existsSync(codexPath)) {
            const existing = fs.readFileSync(codexPath, 'utf8');
            const mcpToml = toCodexToml(config);
            fs.writeFileSync(codexPath, patchCodexToml(existing, mcpToml));
            results.codex = true;
            console.log(`[mcp-sync] ✅ Codex: ${codexPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Codex: config.toml not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Codex:`, (e as Error).message); }

    // 3. Gemini CLI: ~/.gemini/settings.json
    try {
        const geminiPath = join(os.homedir(), '.gemini', 'settings.json');
        if (fs.existsSync(geminiPath)) {
            const geminiData = toClaudeMcp(config);
            patchJsonFile(geminiPath, { mcpServers: geminiData.mcpServers });
            results.gemini = true;
            console.log(`[mcp-sync] ✅ Gemini: ${geminiPath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ Gemini: settings.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Gemini:`, (e as Error).message); }

    // 4. OpenCode: ~/.config/opencode/opencode.json
    try {
        const opencodePath = join(os.homedir(), '.config', 'opencode', 'opencode.json');
        if (fs.existsSync(opencodePath)) {
            const ocMcp = toOpenCodeMcp(config);
            patchJsonFile(opencodePath, { mcp: ocMcp });
            results.opencode = true;
            console.log(`[mcp-sync] ✅ OpenCode: ${opencodePath}`);
        } else {
            console.log(`[mcp-sync] ⏭️ OpenCode: opencode.json not found, skipping`);
        }
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ OpenCode:`, (e as Error).message); }

    // 5. Copilot: ~/.copilot/mcp-config.json
    try {
        const copilotDir = join(os.homedir(), '.copilot');
        const copilotPath = join(copilotDir, 'mcp-config.json');
        const copilotData = toClaudeMcp(config); // same format as Claude
        fs.mkdirSync(copilotDir, { recursive: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(copilotPath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = copilotData.mcpServers;
        fs.writeFileSync(copilotPath, JSON.stringify(existing, null, 4) + '\n');
        results.copilot = true;
        console.log(`[mcp-sync] ✅ Copilot: ${copilotPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Copilot:`, (e as Error).message); }

    // 6. Antigravity: ~/.gemini/antigravity/mcp_config.json
    try {
        const antigravityPath = join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
        const antigravityData = toClaudeMcp(config); // same mcpServers format
        fs.mkdirSync(dirname(antigravityPath), { recursive: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(antigravityPath, 'utf8')) as Record<string, unknown>; } catch { }
        existing["mcpServers"] = antigravityData.mcpServers;
        fs.writeFileSync(antigravityPath, JSON.stringify(existing, null, 4) + '\n');
        results.antigravity = true;
        console.log(`[mcp-sync] ✅ Antigravity: ${antigravityPath}`);
    } catch (e: unknown) { console.error(`[mcp-sync] ❌ Antigravity:`, (e as Error).message); }

    return results;
}
