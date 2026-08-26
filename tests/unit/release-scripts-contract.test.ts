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

for (const scriptPath of ['scripts/release-preview.sh']) {
    test(`${scriptPath} pushes the tree it just built, not a same-named local branch`, () => {
        // `git push origin main` pushes the LOCAL main branch, which is not
        // necessarily what was just built, committed and tagged: releases are
        // cut from whatever branch is checked out. Caught with local main
        // sitting at v2.2.7 while the release commit was on dev -- the push
        // would have published a tree three releases old, and the tag would
        // have pointed somewhere else entirely.
        const script = read(scriptPath);
        const branch = 'preview';

        assert.ok(
            new RegExp(`git push origin HEAD:${branch}`).test(script),
            `${scriptPath} must push HEAD to ${branch}, not the local ${branch} ref`,
        );

        // A bare `git push origin <branch>` is only acceptable when the script
        // has already established that HEAD is that branch.
        for (const line of script.split('\n')) {
            const bare = new RegExp(`^\\s*git push origin ${branch}\\s*$`);
            if (!bare.test(line)) continue;
            assert.ok(
                /CURRENT_BRANCH/.test(script),
                `${scriptPath} pushes the bare ${branch} ref without checking the current branch`,
            );
        }
    });

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

    test(`${scriptPath} waits for the runs publish.yml gates on before dispatching publish`, () => {
        // publish.yml refuses to publish without a SUCCESSFUL PUSH run of
        // test.yml for the exact release SHA, plus postinstall-platform.yml when
        // the installer surface changed. This script pushes and then dispatches,
        // so without a wait the FIRST dispatch of every preview release fails by
        // construction. v2.4.0-preview (18e6337) needed three: 10:29:13 died on
        // "Require successful Tests for this commit" (Tests still running),
        // 10:37:23 died on "Require platform checks when installer surface
        // changed" (Postinstall still running), 10:38:29 finally published.
        const script = read(scriptPath);
        // Collapse backslash-continuations so the multi-line gh invocations can
        // be matched as the single commands they are.
        const flat = script.replace(/\\\r?\n\s*/g, ' ').replace(/[ \t]+/g, ' ');

        assert.ok(
            flat.includes('gh run list --workflow test.yml --branch preview --commit "$RELEASE_SHA" --event push --status success'),
            'release script must wait for a successful PUSH run of test.yml on the exact release SHA',
        );
        assert.ok(
            flat.includes('gh run list --workflow postinstall-platform.yml --branch preview --commit "$RELEASE_SHA" --event push --status success'),
            'release script must wait for a successful PUSH run of postinstall-platform.yml on the exact release SHA',
        );

        const waitIndex = script.indexOf('Waiting for preview Tests');
        // The real dispatch sits at column 0; the resume hint echoes an indented
        // copy of the same command, which must not be mistaken for it.
        const dispatchIndex = script.indexOf('\ngh workflow run publish.yml --ref preview');
        assert.ok(waitIndex !== -1, 'release script must announce the CI wait');
        assert.ok(dispatchIndex !== -1, 'release script must dispatch publish.yml');
        assert.ok(
            waitIndex < dispatchIndex,
            'release script must wait for release CI BEFORE dispatching publish.yml',
        );

        // Mirrors the two wait loops in scripts/promote-to-main.sh.
        assert.ok(script.includes('deadline=$((SECONDS + 1200))'), 'CI wait must be bounded by the same 1200s deadline as promote-to-main.sh');
        assert.ok(script.includes('while [ "$SECONDS" -lt "$deadline" ]'), 'CI wait must poll against the deadline');
        assert.ok(script.includes('sleep 10'), 'CI wait must poll on the promote-to-main.sh interval');
        assert.ok(
            script.includes('failure|cancelled|timed_out|startup_failure|action_required'),
            'CI wait must abort on a failed conclusion instead of polling to the deadline',
        );
        assert.ok(
            script.includes('[ -n "$PREVIEW_TESTS_URL" ] && break'),
            'CI wait must treat an empty result as "run not created yet" and keep polling',
        );
        assert.ok(
            script.includes('ERROR: origin/preview moved while waiting for release CI'),
            'release script must re-check that preview did not move while waiting',
        );

        // postinstall-platform.yml carries `paths:` filters, so it never runs at
        // all for a SHA that touches no installer-sensitive path. Waiting
        // unconditionally would burn the full deadline on a run that will never
        // exist, so the wait is gated on the same detector publish.yml uses.
        assert.ok(
            flat.includes('node scripts/require-release-evidence.mjs --changed-files-stdin'),
            'platform wait must be decided by the shared installer-sensitive path detector',
        );
        assert.ok(
            script.includes('if [ "$PLATFORM_REQUIRED" = true ]'),
            'platform wait must be conditional, not unconditional',
        );

        assert.ok(
            script.includes('publish_dispatch_hint'),
            'every give-up path must print the exact resume dispatch command',
        );
    });

    test(`${scriptPath} describes the dispatch-triggered publish, not the removed push trigger`, () => {
        const script = read(scriptPath);

        assert.ok(
            !script.includes('runs from \\`.github/workflows/publish.yml\\` on the \\`preview\\` branch'),
            'prerelease body must not claim publish is triggered by the preview branch push',
        );
        assert.ok(
            !script.includes('publish.yml?query=branch%3Apreview'),
            'publish.yml has no push trigger, so a branch-filtered actions URL lists nothing',
        );
        assert.ok(
            script.includes('publish.yml?query=event%3Aworkflow_dispatch'),
            'the workflow link must filter on the dispatch event that actually publishes',
        );
    });
}

test('stable promotion delegates checkout isolation and never auto-rewrites docs', () => {
    const script = read('scripts/promote-to-main.sh');

    assert.ok(script.includes('source "$SCRIPT_DIR/promotion-checkout.sh"'));
    assert.ok(script.includes('prepare_promotion_checkout'));
    assert.ok(script.includes('assert_promotion_checkout_ready_to_push'));
    assert.ok(script.includes('cleanup_promotion_checkout'));
    assert.ok(!script.includes('git worktree add'));
    assert.ok(!script.includes('verify-counts.sh --fix'));
});

test('stable promotion cleans up its checkout without leaking a remote branch', () => {
    // The old promotion minted codex/promote-<version>-<sha12> on origin, so the
    // trap had to delete it on every abort between push and merge; five such
    // branches leaked before that was fixed. ff promotion never creates a remote
    // branch at all, so the whole failure mode is gone and the trap is back to
    // one job: remove the local checkout.
    const script = read('scripts/promote-to-main.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));

    assert.ok(cleanup.includes('cleanup() {'), 'promotion script must still install a cleanup trap body');
    assert.ok(
        cleanup.includes('if ! cleanup_promotion_checkout "$WORKTREE"; then'),
        'cleanup must keep removing the local promotion checkout',
    );
    assert.ok(
        cleanup.includes('WARNING: failed to clean promotion checkout'),
        'cleanup must keep warning when the local checkout cannot be removed',
    );

    // No remote branch is created, so nothing may try to delete one.
    assert.ok(
        !/git push origin --delete/.test(script),
        'ff promotion creates no remote branch; a delete path would only be able to remove someone else\'s',
    );

    // The trap fires on the very failure it is cleaning up after, so it must not
    // become the thing that decides the exit code.
    assert.ok(
        /cleanup\(\) \{\n  local status=\$\?\n/.test(script),
        'cleanup must capture the original exit status before running anything else',
    );
    assert.ok(cleanup.includes('exit "$status"'), 'cleanup must re-raise the original exit status');

    // Under `set -e` a bare failing command inside the trap aborts the trap and
    // replaces the real exit code, so every fallible cleanup command has to sit
    // in a condition.
    for (const line of cleanup.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !/\bgit /.test(trimmed)) continue;
        assert.ok(
            /^(if|elif) /.test(trimmed),
            `cleanup runs "${trimmed}" outside a condition: under set -e that aborts the trap and rewrites the exit code`,
        );
    }
});

test('stable promotion fast-forwards instead of squashing through a PR', () => {
    // The invariant: main must never gain a commit preview does not have. A PR
    // merge of any kind mints a new SHA and breaks that, which is what forced the
    // realignment step and, through it, the 2.17.13 code loss.
    const script = read('scripts/promote-to-main.sh');

    assert.ok(!script.includes('gh pr create'), 'promotion must not open a PR');
    assert.ok(!script.includes('gh pr merge'), 'promotion must not merge a PR');
    assert.ok(!script.includes('--squash'), 'promotion must not squash');
    assert.ok(
        script.includes('git push origin "$PROMOTION_COMMIT:refs/heads/main"'),
        'promotion must fast-forward main onto the certified commit',
    );
    // A plain push is what makes "fast-forward only" enforced by git rather than
    // by convention: git refuses a non-ff update on its own.
    assert.ok(
        !/git push[^\n]*--force[^\n]*refs\/heads\/main/.test(script),
        'the main push must never be forced: refusing a non-ff is the actual guarantee',
    );
    assert.ok(
        script.includes('--force-with-lease="refs/heads/preview:$PREVIEW_SHA"'),
        'the preview push must be leased to the certified SHA so a concurrent push is refused, not discarded',
    );

    // The bump has to be certified on preview before main takes it, because that
    // push run is the evidence publish.yml gates on.
    assert.ok(
        script.indexOf('refs/heads/preview"') < script.indexOf('refs/heads/main"'),
        'preview must move first: main takes only what preview CI already certified',
    );
});

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

    assert.ok(!workflow.includes('- master'), 'publish workflow must not bind the removed master branch');
    assert.ok(!workflow.includes('- dev'), 'publish workflow must not publish from the development branch');
    assert.ok(workflow.includes('id-token: write'), 'publish workflow must support npm Trusted Publishing OIDC');
    assert.ok(workflow.includes('latest:main'), 'real latest publishes must run only from main');
    assert.ok(!workflow.includes('latest:master'), 'real latest publishes must not accept master');
    assert.ok(workflow.includes('expected-sha'), 'publish dispatch must require the expected SHA');
    assert.ok(workflow.includes('Verify dispatched SHA'), 'publish workflow must verify the dispatched SHA matches HEAD');
    assert.ok(workflow.includes('Require successful Tests for this commit'), 'publish workflow must require a passing test run for the same commit');
    assert.ok(workflow.includes('Check registry package version'), 'publish workflow must detect already-published versions');
    assert.ok(workflow.includes('SKIP - cli-jaw@${{ steps.release.outputs.version }} is already published'),
        'publish workflow must skip npm publish when the exact version already exists');
    assert.ok(workflow.includes('gh release view "$tag"'),
        'publish workflow must check for existing GitHub release before create-or-edit');
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
    const releaseScript = read('scripts/promote-to-main.sh');
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
        assert.ok(!workflow.includes('- dev'), 'CI workflows must not run on dev after M0');
        assert.ok(workflow.includes('- preview'), 'CI workflows must run on preview');
        assert.ok(workflow.includes('- main'), 'CI workflows must run on main');
        assert.ok(!workflow.includes('- master'), 'CI workflows must not run on removed master');
    }
    assert.ok(pagesWorkflow.includes('branches: [main]'), 'Pages deploy must publish docs from main');
    assert.ok(!pagesWorkflow.includes('branches: [master]'), 'Pages deploy must not depend on master');

    assert.ok(
        releaseScript.includes('git merge-base --is-ancestor "$MAIN_SHA" "$PREVIEW_SHA"'),
        'stable promotion script must verify main is an ancestor of preview',
    );
    assert.ok(
        releaseScript.includes('expected-sha="$MERGED_MAIN_SHA"'),
        'stable promotion script must dispatch publish.yml with exact main SHA',
    );

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

test('electron-builder scripts stay free of POSIX command substitution', () => {
    // `PYTHON="$(bash ../scripts/pick-gyp-python.sh)"` is a macOS-only guard: it
    // finds a python3 that still has distutils for node-gyp. npm runs scripts
    // through cmd.exe on Windows, which does not expand `$(...)`, so the literal
    // string reached Python as a filename:
    //
    //   PYTHON: can't open file 'D:\a\cli-jaw\cli-jaw\electron\=$(bash ..\scripts\pick-gyp-python.sh)'
    //
    // That failed the Windows job of every desktop release from v2.2.11 onward
    // while macOS and Linux stayed green, so the release itself still looked
    // successful. CI does not need the guard anyway: desktop-release.yml pins
    // actions/setup-python to 3.11 for exactly this reason.
    const electronPkg = JSON.parse(read('electron/package.json')) as { scripts?: Record<string, string> };
    const scripts = electronPkg.scripts ?? {};

    for (const [name, body] of Object.entries(scripts)) {
        if (!name.startsWith('dist:')) continue;

        assert.ok(
            !body.includes('$('),
            `${name} must not use POSIX command substitution: npm runs it through cmd.exe on Windows (got: ${body})`,
        );
    }
});
