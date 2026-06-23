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
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-mac-no-jwc'), 'desktop workflow must bind macOS to the mac packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-win-no-jwc'), 'desktop workflow must bind Windows to the Windows packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('sidecar_check_script: check:electron-dist-linux-no-jwc'), 'desktop workflow must bind Linux to the Linux packaged sidecar no-JWC verifier');
    assert.ok(workflow.includes('Verify packaged app has no JWC payload'), 'desktop workflow must verify packaged app excludes JWC before upload on every OS');
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

test('npm publish workflow uses dev/preview/main branch policy without release retargeting existing versions', () => {
    const workflow = read('.github/workflows/publish.yml');

    assert.ok(workflow.includes('push:'), 'publish workflow must run from branch pushes');
    assert.ok(workflow.includes('- preview'), 'publish workflow must bind the preview branch');
    assert.ok(workflow.includes('- main'), 'publish workflow must bind the main branch');
    assert.ok(!workflow.includes('- master'), 'publish workflow must not bind the removed master branch');
    assert.ok(!workflow.includes('- dev'), 'publish workflow must not publish from the development branch');
    assert.ok(workflow.includes('id-token: write'), 'publish workflow must support npm Trusted Publishing OIDC');
    assert.ok(workflow.includes('latest:main) ;;'), 'real latest publishes must run only from main');
    assert.ok(!workflow.includes('latest:master'), 'real latest publishes must not accept master');
    assert.ok(workflow.includes('skip_publish="true"'), 'preview stable sync must set an explicit skip output');
    assert.ok(workflow.includes('preview branch stable sync'), 'preview stable sync skip should be visible in the workflow logs');
    assert.ok(workflow.includes('Check registry package version'), 'publish workflow must detect already-published versions');
    assert.ok(workflow.includes('SKIP - cli-jaw@${{ steps.release.outputs.version }} is already published'),
        'publish workflow must skip npm publish when the exact version already exists');
    assert.ok(workflow.includes("steps.registry.outputs.exists != 'true'"),
        'publish workflow must not retarget a GitHub Release for an already-published npm version');
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

test('release branch policy is reflected in CI workflows, release script, installers, and public docs', () => {
    const testWorkflow = read('.github/workflows/test.yml');
    const postinstallWorkflow = read('.github/workflows/postinstall-platform.yml');
    const pagesWorkflow = read('.github/workflows/pages.yml');
    const releaseScript = read('scripts/release.sh');
    const installScript = read('scripts/install.sh');
    const installWslScript = read('scripts/install-wsl.sh');
    const collectorScript = read('scripts/collect-fresh-install-evidence.sh');
    const readmes = [
        read('README.md'),
        read('README.ko.md'),
        read('README.ja.md'),
        read('README.zh-CN.md'),
    ].join('\n');
    const docs = [
        read('docs/index.html'),
        read('docs/windows.html'),
    ].join('\n');

    for (const workflow of [testWorkflow, postinstallWorkflow]) {
        assert.ok(workflow.includes('- dev'), 'CI workflows must run on dev');
        assert.ok(workflow.includes('- preview'), 'CI workflows must run on preview');
        assert.ok(workflow.includes('- main'), 'CI workflows must run on main');
        assert.ok(!workflow.includes('- master'), 'CI workflows must not run on removed master');
    }
    assert.ok(pagesWorkflow.includes('branches: [main]'), 'Pages deploy must publish docs from main');
    assert.ok(!pagesWorkflow.includes('branches: [master]'), 'Pages deploy must not depend on master');

    assert.ok(releaseScript.includes('git push origin main'), 'stable release script must push main');
    assert.ok(!releaseScript.includes('git push origin master'), 'stable release script must not push master');
    assert.ok(releaseScript.includes('branch%3Amain'), 'stable release script must link to main workflow runs');
    assert.ok(!releaseScript.includes('branch%3Amaster'), 'stable release script must not link to master workflow runs');

    assert.ok(installScript.includes('/cli-jaw/main/scripts/install.sh'), 'install.sh usage should use main raw URL');
    assert.ok(installWslScript.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'install-wsl.sh usage should use main raw URL');
    assert.ok(collectorScript.includes('INSTALL_REF="${CLI_JAW_INSTALL_REF:-main}"'), 'fresh evidence collector should default to main');

    assert.ok(readmes.includes('/cli-jaw/main/scripts/install.sh'), 'README install URLs should use main');
    assert.ok(readmes.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'README WSL install URLs should use main');
    assert.ok(readmes.includes('/cli-jaw/main/scripts/collect-fresh-install-evidence.sh'), 'README evidence URLs should use main');
    assert.ok(!readmes.includes('raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/'), 'README files must not point installers at master');
    assert.ok(readmes.includes('branch from `dev`') || readmes.includes('`dev`에서 Fork') || readmes.includes('`dev` から Fork') || readmes.includes('从 `dev` Fork'),
        'contributor guidance should direct branches from dev');

    assert.ok(docs.includes('/cli-jaw/main/scripts/install.sh'), 'landing page install URL should use main');
    assert.ok(docs.includes('/cli-jaw/main/scripts/install-wsl.sh'), 'Windows docs install URL should use main');
    assert.ok(!docs.includes('raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install'), 'static docs must not point installers at master');
});
