/**
 * Shared instance utilities for launchd / systemd / docker service management.
 * Zero dependencies beyond node:* and config.ts.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { JAW_HOME } from './config.js';

/**
 * Derive a human-readable instance ID from JAW_HOME.
 * Default home (~/.cli-jaw) → 'default'
 * Custom home → '<basename>-<hash8>'
 */
export function instanceId(): string {
    const base = basename(JAW_HOME);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(JAW_HOME).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

/** Resolve absolute path to node binary. */
export function getNodePath(): string {
    try { return execFileSync('which', ['node'], { encoding: 'utf8' }).trim(); }
    catch { return '/usr/local/bin/node'; }
}

/** Resolve absolute path to jaw binary. */
export function getJawPath(): string {
    try { return execFileSync('which', ['jaw'], { encoding: 'utf8' }).trim(); }
    catch { return execFileSync('which', ['cli-jaw'], { encoding: 'utf8' }).trim(); }
}

/**
 * Sanitize a string for use as a systemd unit name.
 * Allowed: [a-zA-Z0-9:._-]
 * @see systemd.unit(5)
 */
export function sanitizeUnitName(name: string): string {
    return name.replace(/[^a-zA-Z0-9:._-]/g, '-');
}
