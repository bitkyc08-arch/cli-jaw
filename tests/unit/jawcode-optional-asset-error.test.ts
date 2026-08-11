import test from 'node:test';
import assert from 'node:assert/strict';
import { isOptionalJawcodeTuiLoadError } from '../../src/cli/tui/jawcode-render.ts';

// Regression cover for #275. The classifier used to match forward-slash
// literals only, so on Windows a missing optional asset escaped the fallback
// and crashed `jaw chat --raw`. These cases are deterministic on every host:
// the sibling render test can only exercise whatever assets happen to exist
// locally, which is why the Windows branch went unnoticed.

function moduleNotFound(message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = 'ERR_MODULE_NOT_FOUND';
    return err;
}

test('#275: the reported Windows backslash message is treated as optional', () => {
    const err = moduleNotFound(
        "Cannot find module 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules"
        + "\\cli-jaw\\dist\\src\\lib\\tui\\bun-shim.mjs' imported from "
        + 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\cli-jaw'
        + '\\dist\\src\\cli\\tui\\jawcode-render.js',
    );
    assert.equal(isOptionalJawcodeTuiLoadError(err), true);
});

test('POSIX message for the same asset stays optional', () => {
    const err = moduleNotFound("Cannot find module '/opt/cli-jaw/dist/src/lib/tui/bun-shim.mjs'");
    assert.equal(isOptionalJawcodeTuiLoadError(err), true);
});

test('file:// URL form is treated as optional', () => {
    const err = moduleNotFound(
        "Cannot find module 'file:///C:/Users/user/cli-jaw/dist/src/lib/tui/bun-shim.mjs'",
    );
    assert.equal(isOptionalJawcodeTuiLoadError(err), true);
});

test('generated jawcode bundles are optional on both separators', () => {
    assert.equal(
        isOptionalJawcodeTuiLoadError(moduleNotFound("Cannot find module '/a/lib/tui/jawcode-tui-bundle.mjs'")),
        true,
    );
    assert.equal(
        isOptionalJawcodeTuiLoadError(moduleNotFound("Cannot find module 'C:\\a\\lib\\tui\\jawcode-interactive-bundle.mjs'")),
        true,
    );
});

test('a missing pi_natives addon is optional regardless of error code', () => {
    assert.equal(isOptionalJawcodeTuiLoadError(new Error('pi_natives.darwin-arm64.node not found')), true);
});

test('an unrelated missing module is NOT swallowed', () => {
    const err = moduleNotFound("Cannot find module '/app/dist/src/core/config.js'");
    assert.equal(isOptionalJawcodeTuiLoadError(err), false);
});

test('a non-ERR_MODULE_NOT_FOUND failure on the same path is NOT swallowed', () => {
    // A syntax error inside the shim must surface, not be mistaken for absence.
    const err = new Error('Unexpected token in /lib/tui/bun-shim.mjs') as Error & { code: string };
    err.code = 'ERR_MODULE_SYNTAX';
    assert.equal(isOptionalJawcodeTuiLoadError(err), false);
});

test('non-Error throwables do not crash the classifier', () => {
    assert.equal(isOptionalJawcodeTuiLoadError('some string'), false);
    assert.equal(isOptionalJawcodeTuiLoadError(undefined), false);
    assert.equal(isOptionalJawcodeTuiLoadError(null), false);
});
