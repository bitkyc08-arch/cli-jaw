#!/usr/bin/env node
/**
 * Best-effort cleanup for npm staging directories left behind on Windows.
 *
 * A probe cannot close the Windows TOCTOU window between checking files and
 * removing the directory.  If a file becomes locked after the probe, rm fails
 * and the ledger-backed .deleting directory remains visible to doctor and is
 * retried on the next install.
 */
const fs = require('fs');
const path = require('path');

const LEDGER_FILE = '.cli-jaw-cleanup-ledger.json';
const LOCK_ERRORS = new Set(['EBUSY', 'EACCES', 'EPERM']);

function defaultReadName(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    } catch {
        return null;
    }
}

function defaultWalkFiles(dir) {
    const files = [];
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile()) files.push(target);
        }
    };
    visit(dir);
    return files;
}

function defaultProbeOpen(file) {
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
}

function defaultReadLedger(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
        return [];
    }
}

function defaultWriteLedger(file, entries) {
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries }, null, 2));
}

function dependencies(deps = {}) {
    return {
        rm: deps.rm || (target => fs.rmSync(target, { recursive: true, force: true })),
        rename: deps.rename || fs.renameSync,
        readName: deps.readName || defaultReadName,
        probeOpen: deps.probeOpen || defaultProbeOpen,
        walkFiles: deps.walkFiles || defaultWalkFiles,
        readLedger: deps.readLedger || defaultReadLedger,
        writeLedger: deps.writeLedger || defaultWriteLedger,
        log: deps.log || (() => {}),
    };
}

function scan(nodeModulesDir, deps) {
    const ledgerPath = path.join(nodeModulesDir, LEDGER_FILE);
    const ledger = deps.readLedger(ledgerPath);
    const entries = Array.isArray(ledger) ? ledger : [];
    const verifiedRetries = new Set(entries
        .filter(entry => entry && entry.verifiedName === 'cli-jaw' && typeof entry.dir === 'string')
        .map(entry => entry.dir));
    let names;
    try {
        names = fs.readdirSync(nodeModulesDir);
    } catch {
        return { ledgerPath, entries, fresh: [], retries: [] };
    }

    const fresh = [];
    const retries = [];
    for (const name of names) {
        const candidate = path.join(nodeModulesDir, name);
        if (name.endsWith('.deleting')) {
            if (verifiedRetries.has(name)) retries.push({ name, path: candidate });
            continue;
        }
        if (/^\.cli-jaw-/.test(name) && deps.readName(candidate) === 'cli-jaw') {
            fresh.push({ name, path: candidate });
        }
    }
    return { ledgerPath, entries, fresh, retries };
}

function listStaleStaging(nodeModulesDir, suppliedDeps = {}) {
    const deps = dependencies(suppliedDeps);
    const found = scan(nodeModulesDir, deps);
    return [...found.fresh, ...found.retries].map(candidate => candidate.name);
}

function cleanupStaleStaging(nodeModulesDir, suppliedDeps = {}) {
    const deps = dependencies(suppliedDeps);
    const found = scan(nodeModulesDir, deps);
    const removed = [];
    const skipped = [];
    let ledger = [...found.entries];

    const persistLedger = () => deps.writeLedger(found.ledgerPath, ledger);
    const removeLedgerEntry = dir => {
        ledger = ledger.filter(entry => entry?.dir !== dir);
        persistLedger();
    };

    for (const candidate of found.retries) {
        try {
            deps.rm(candidate.path);
            removed.push(candidate.name);
            removeLedgerEntry(candidate.name);
        } catch (error) {
            skipped.push(candidate.name);
            deps.log(`staging cleanup retry skipped ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    for (const candidate of found.fresh) {
        let locked = false;
        try {
            for (const file of deps.walkFiles(candidate.path)) deps.probeOpen(file);
        } catch (error) {
            if (LOCK_ERRORS.has(error?.code)) locked = true;
            else {
                skipped.push(candidate.name);
                deps.log(`staging cleanup probe skipped ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
        }
        if (locked) {
            skipped.push(candidate.name);
            continue;
        }

        const deletingName = `${candidate.name}.deleting`;
        const deletingPath = path.join(nodeModulesDir, deletingName);
        ledger = ledger.filter(entry => entry?.dir !== deletingName);
        ledger.push({ dir: deletingName, verifiedName: 'cli-jaw', renamedAt: new Date().toISOString() });
        try {
            persistLedger();
            deps.rename(candidate.path, deletingPath);
        } catch (error) {
            skipped.push(candidate.name);
            deps.log(`staging cleanup rename skipped ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        try {
            deps.rm(deletingPath);
            removed.push(candidate.name);
            removeLedgerEntry(deletingName);
        } catch (error) {
            skipped.push(deletingName);
            deps.log(`staging cleanup remove skipped ${deletingName}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return { removed, skipped };
}

module.exports = { cleanupStaleStaging, listStaleStaging };
