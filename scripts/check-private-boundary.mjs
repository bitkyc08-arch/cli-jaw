#!/usr/bin/env node
// Public repository boundary. Check the index locally/CI, and every newly
// introduced commit before push (including an add-then-delete sequence).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isPrivatePath(file) {
    return file.replaceAll('\\', '/').split('/').some(segment =>
        /^(?:devlog(?:[._-].*)?|cli-jaw-internal|_plan|_fin|\.jwc)$/i.test(segment));
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function rejectPaths(paths, label) {
    const forbidden = paths.filter(isPrivatePath);
    if (forbidden.length) throw new Error(label + ': private paths must live outside cli-jaw:\n' + forbidden.join('\n'));
}

export function checkIndex(cwd) {
    rejectPaths(git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean), 'index');
}

export function checkRange(cwd, base, head, destination) {
    // Range endpoints come from Git's pre-push protocol or explicit CLI args.
    // rev-parse verifies them as commits before any option-bearing git call.
    const oid = ref => git(cwd, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
    const headId = oid(head);
    const baseId = base ? oid(base) : null;
    // A new ref has no old tip. Only exclude commits actually advertised by
    // THIS destination; unrelated/private remote-tracking refs prove nothing.
    let revArgs;
    if (baseId) {
        revArgs = [baseId + '..' + headId];
    } else {
        if (!destination) throw new Error('A destination is required to check a new remote ref');
        const advertised = git(cwd, ['ls-remote', '--refs', '--', destination])
            .split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]);
        if (advertised.some(sha => !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Invalid destination refs');
        const available = advertised.length ? execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
            cwd, encoding: 'utf8', input: advertised.map(sha => sha + '^{commit}').join('\n') + '\n',
            maxBuffer: 64 * 1024 * 1024,
        }).split('\n').filter(line => /^[a-f0-9]{40,64} commit$/.test(line)).map(line => line.split(' ')[0]) : [];
        revArgs = available.length ? [headId, '--not', ...available] : [headId];
    }
    const commits = new Set([headId, ...git(cwd, ['rev-list', ...revArgs]).trim().split('\n').filter(Boolean)]);
    for (const commit of commits) {
        rejectPaths(git(cwd, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean), commit);
    }
}

export function checkPush(cwd, input, destination) {
    const zero = /^0+$/;
    for (const line of input.trim().split('\n').filter(Boolean)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]) || !/^[a-f0-9]{40,64}$/.test(fields[3])) {
            throw new Error('Invalid pre-push ref update');
        }
        if (zero.test(fields[1])) continue; // deletion introduces no content
        checkRange(cwd, zero.test(fields[3]) ? null : fields[3], fields[1], destination);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        if (args[0] === '--pre-push' && args.length <= 2) {
            checkPush(process.cwd(), readFileSync(0, 'utf8'), args[1]);
        } else if (args[0] === '--range' && args.length === 3) {
            checkRange(process.cwd(), args[1], args[2]);
        } else if (args.length === 0) {
            checkIndex(process.cwd());
        } else {
            throw new Error('Usage: check-private-boundary.mjs [--pre-push <destination> | --range <base> <head>]');
        }
        console.log('[private-boundary] OK');
    } catch (error) {
        console.error('[private-boundary] ' + error.message);
        process.exitCode = 1;
    }
}
