import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

for (const scriptPath of ['scripts/release.sh', 'scripts/release-preview.sh']) {
    test(`${scriptPath} validates Electron shell before publishing`, () => {
        const script = read(scriptPath);

        assert.ok(script.includes('run_electron_release_checks'), 'release script must define and call Electron release checks');
        assert.ok(script.includes('npm run check:electron-no-native'), 'release script must keep npm package Electron-free');
        assert.ok(script.includes('npm --prefix electron run typecheck'), 'release script must typecheck Electron shell');
        assert.ok(script.includes('npm --prefix electron run build'), 'release script must build Electron shell');
        assert.ok(script.includes('ELECTRON_RELEASE_NOTES'), 'release script must include Electron status in GitHub release notes');
        assert.ok(script.includes('Desktop / Electron'), 'GitHub release notes must include a Desktop / Electron section');
    });

    test(`${scriptPath} delegates desktop distribution to release-triggered GitHub Actions`, () => {
        const script = read(scriptPath);

        assert.ok(
            script.includes('--with-desktop'),
            'release script must keep --with-desktop as a backward-compatible no-op',
        );
        assert.ok(
            script.includes('GitHub Actions builds desktop assets after release publication'),
            'release script must route desktop assets to GitHub Actions',
        );
        assert.ok(
            script.includes('unsigned'),
            'release notes must contain the literal "unsigned" warning for desktop artifacts',
        );
        assert.ok(
            script.includes('xattr -d com.apple.quarantine'),
            'release notes must instruct macOS users on the xattr -d com.apple.quarantine workaround',
        );
        assert.ok(
            !script.includes('npm --prefix electron run dist:mac'),
            'release script must not build desktop installers locally',
        );
        assert.ok(
            !script.includes('DESKTOP_ARTIFACTS'),
            'release script must not collect local desktop artifacts',
        );
        assert.ok(
            script.includes('gh release create'),
            'release script must invoke gh release create',
        );
    });
}

test('desktop release workflow uploads OS matrix artifacts only after GitHub release publication', () => {
    const workflow = read('.github/workflows/desktop-release.yml');

    assert.ok(workflow.includes('release:'), 'desktop workflow must be release-triggered');
    assert.ok(workflow.includes('types: [published]'), 'desktop workflow must run only after release publication');
    assert.ok(workflow.includes('workflow_dispatch:'), 'desktop workflow must also support manual release-tag dispatches');
    assert.ok(workflow.includes('release-tag:'), 'manual desktop release dispatch must accept a release tag');
    assert.ok(workflow.includes('upload-release-assets:'), 'manual desktop release dispatch must have an explicit release upload gate');
    assert.ok(!workflow.includes('push:'), 'desktop workflow must not run on git push');
    assert.ok(workflow.includes('macos-latest'), 'desktop workflow must build macOS artifacts');
    assert.ok(workflow.includes('windows-2022'), 'desktop workflow must pin Windows packaging to the VS 2022 runner for node-gyp native rebuilds');
    assert.ok(!workflow.includes('os: windows-latest'), 'desktop workflow must not use the moving windows-latest label for native packaging');
    assert.ok(workflow.includes('ubuntu-latest'), 'desktop workflow must build Linux artifacts');
    assert.ok(workflow.includes('node-version: 24'), 'desktop workflow host Node must match the Node 24 sidecar release line');
    assert.ok(workflow.includes('npm --prefix electron run typecheck'), 'desktop workflow must typecheck Electron shell');
    assert.ok(workflow.includes('npm --prefix electron run build'), 'desktop workflow must build Electron shell');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-mac-jwc'), 'desktop workflow must bind macOS to the mac packaged sidecar verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-win-jwc'), 'desktop workflow must bind Windows to the Windows packaged sidecar verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-linux-jwc'), 'desktop workflow must bind Linux to the Linux packaged sidecar verifier');
    assert.ok(workflow.includes('Verify packaged app JWC'), 'desktop workflow must verify packaged app JWC before upload on every OS');
    assert.ok(workflow.includes('npm run ${{ matrix.sidecar_check_script }}'), 'desktop workflow must run the OS-specific final sidecar verifier');
    assert.ok(workflow.includes('Verify macOS app icons'), 'desktop workflow must validate macOS app icons separately');
    assert.ok(workflow.includes("if: matrix.platform == 'macos'"), 'macOS icon verification must not run on Windows/Linux matrix legs');
    assert.ok(workflow.includes('npm run check:app-icons'), 'desktop workflow must validate app icon assets before uploading macOS artifacts');
    assert.ok(workflow.includes('CSC_IDENTITY_AUTO_DISCOVERY: false'), 'desktop workflow must keep unsigned mac builds explicit');
    assert.ok(workflow.includes('gh release upload'), 'desktop workflow must upload artifacts to the existing release');
    assert.ok(
        workflow.includes('ref: ${{ inputs.release-tag || github.event.release.tag_name || github.ref }}'),
        'manual desktop release dispatch must check out the selected release tag',
    );
    assert.ok(
        workflow.includes("github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.release-tag != '' && inputs.upload-release-assets == true)"),
        'manual desktop release dispatch must upload release assets only when a non-empty tag and explicit upload gate are present',
    );
    assert.ok(
        workflow.includes('TAG_NAME: ${{ inputs.release-tag || github.event.release.tag_name }}'),
        'desktop release upload must use the manual release tag when dispatched',
    );
    assert.ok(workflow.includes('--clobber'), 'desktop workflow reruns must replace stale release assets');
});

test('npm publish workflow creates GitHub releases and is safe to rerun for an existing version', () => {
    const workflow = read('.github/workflows/publish.yml');

    assert.ok(workflow.includes('push:'), 'publish workflow must run from branch pushes');
    assert.ok(workflow.includes('- preview'), 'publish workflow must bind the preview branch');
    assert.ok(workflow.includes('- master'), 'publish workflow must bind the master branch');
    assert.ok(workflow.includes('id-token: write'), 'publish workflow must support npm Trusted Publishing OIDC');
    assert.ok(workflow.includes('Check registry package version'), 'publish workflow must detect already-published versions');
    assert.ok(workflow.includes('SKIP - cli-jaw@${{ steps.release.outputs.version }} is already published'),
        'publish workflow must skip npm publish when the exact version already exists');
    assert.ok(workflow.includes('Create GitHub release'), 'publish workflow must create or update a GitHub Release');
    assert.ok(workflow.includes('--prerelease'), 'preview publishes must create GitHub prereleases');
    assert.ok(workflow.includes('previous_tag='), 'GitHub release notes must derive the previous tag automatically');
    assert.ok(workflow.includes('git rev-list "$previous_tag"..HEAD --count'), 'GitHub release notes must include commit count');
    assert.ok(workflow.includes("git log \"$previous_tag\"..HEAD -n 80 --pretty=format:'- %s' --no-merges"),
        'GitHub release notes must include commit subjects');
    assert.ok(workflow.includes('**Previous**:'), 'GitHub release notes must include a Previous line');
    assert.ok(workflow.includes('### Changes'), 'GitHub release notes must include a Changes section');
    assert.ok(workflow.includes('--target "$GITHUB_SHA"'), 'release edits must retarget the release to the current publish commit');
    assert.ok(workflow.includes('notes-file'), 'GitHub releases should be created from a structured notes file');
});
