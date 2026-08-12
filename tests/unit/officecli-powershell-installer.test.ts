import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(import.meta.dirname, '../../scripts/install-officecli.ps1');
const windowsOnly = {
    skip: process.platform === 'win32' ? false : 'requires Windows PowerShell',
};

function encodedPowerShell(source: string): string {
    return Buffer.from(source, 'utf16le').toString('base64');
}

function runInstaller(release: { tag: string; assets: string[] }, repo?: string) {
    const localAppData = mkdtempSync(join(tmpdir(), 'jaw-officecli-ps-'));
    const assetRows = release.assets
        .map(name => `[pscustomobject]@{ name = '${name.replaceAll("'", "''")}' }`)
        .join(', ');
    const repoSetup = repo
        ? `$env:OFFICECLI_REPO = '${repo.replaceAll("'", "''")}'`
        : `Remove-Item Env:OFFICECLI_REPO -ErrorAction SilentlyContinue`;
    const command = `
        $env:LOCALAPPDATA = '${localAppData.replaceAll("'", "''")}'
        ${repoSetup}
        function Invoke-RestMethod {
            [pscustomobject]@{
                tag_name = '${release.tag.replaceAll("'", "''")}'
                assets = @(${assetRows})
            }
        }
        function Invoke-WebRequest { throw 'DOWNLOAD_REACHED' }
        & '${installer.replaceAll("'", "''")}' -Force
    `;
    try {
        const result = spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', encodedPowerShell(command),
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 20_000,
        });
        return {
            status: result.status,
            output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        };
    } finally {
        rmSync(localAppData, { recursive: true, force: true });
    }
}

test('#280: Windows fork install fails before download when the release omits its asset', windowsOnly, () => {
    const result = runInstaller({ tag: 'v1.0.98', assets: ['officecli-mac-arm64'] });

    assert.equal(result.status, 1);
    assert.match(result.output, /lidge-jun\/OfficeCLI latest release \(v1\.0\.98\) has no officecli-win-(?:x64|arm64)\.exe/);
    assert.match(result.output, /published: officecli-mac-arm64/);
    assert.match(result.output, /-Upstream/);
    assert.match(result.output, /fork is required only for CJK font handling and HWP/);
    assert.doesNotMatch(result.output, /DOWNLOAD_REACHED/);
});

test('#280: Windows upstream install proceeds when the release publishes its asset', windowsOnly, () => {
    const result = runInstaller({
        tag: 'v1.0.143',
        assets: ['officecli-win-x64.exe', 'officecli-win-arm64.exe', 'SHA256SUMS'],
    }, 'iOfficeAI/OfficeCLI');

    assert.notEqual(result.status, 0, 'the download sentinel intentionally aborts the install');
    assert.match(result.output, /DOWNLOAD_REACHED/);
    assert.doesNotMatch(result.output, /latest release .* has no/);
});
