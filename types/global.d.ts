// Global type declarations for cli-claw-ts

declare module 'node-fetch' {
  export default function fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface CliClawConfig {
  port: number;
  host: string;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface Settings {
  telegram: {
    token: string;
    allowedChatIds: string[];
  };
  agents: Record<string, AgentConfig>;
}

export interface AgentConfig {
  cli: string;
  model?: string;
  permissions?: string;
}

export interface HeartbeatJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: 'every' | 'cron';
    minutes?: number;
    cron?: string;
  };
  prompt: string;
}

export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'snapshot' | 'screenshot' | 'press' | 'text';
  target?: string;
  value?: string;
  options?: Record<string, unknown>;
}

export interface OrchestratorSubtask {
  agent: string;
  task: string;
  priority: number;
}

export interface AgentEvent {
  type: string;
  timestamp: number;
  sessionId: string;
  data: unknown;
}
