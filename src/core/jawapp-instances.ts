/**
 * Jaw.app instance registry — CRUD for ~/.cli-jaw/instances.json.
 * The registry is global (keyed to default home, not per-instance JAW_HOME)
 * because Jaw.app's serve-manager needs a single known location.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface JawAppInstance {
    home: string;
    port: number;
}

interface InstancesFile {
    instances: JawAppInstance[];
}

export function getInstancesPath(): string {
    return join(homedir(), '.cli-jaw', 'instances.json');
}

export function readInstances(): JawAppInstance[] {
    try {
        const raw = readFileSync(getInstancesPath(), 'utf8');
        const data: InstancesFile = JSON.parse(raw);
        if (!Array.isArray(data.instances)) return [];
        return data.instances.filter(
            (i) => typeof i.home === 'string' && typeof i.port === 'number',
        );
    } catch {
        return [];
    }
}

function writeInstances(instances: JawAppInstance[]): void {
    const p = getInstancesPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ instances } as InstancesFile, null, 2) + '\n');
}

export function addInstance(home: string, port: number): JawAppInstance[] {
    const list = readInstances();
    const exists = list.some((i) => i.home === home && i.port === port);
    if (exists) return list;
    list.push({ home, port });
    writeInstances(list);
    return list;
}

export function removeInstance(home: string, port: number): JawAppInstance[] {
    const list = readInstances().filter(
        (i) => !(i.home === home && i.port === port),
    );
    writeInstances(list);
    return list;
}

export function listInstances(): JawAppInstance[] {
    return readInstances();
}
