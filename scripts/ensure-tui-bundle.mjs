#!/usr/bin/env node
// Ensure the prebuilt jawcode TUI bundle exists before `npm run build`.
//
// The rich `jaw chat` TUI loads dist/src/lib/tui/jawcode-tui-bundle.mjs, a Node
// bundle of @jawcode-dev/tui. It is gitignored and isn't produced by tsc, so
// unless it is generated here the published package ships without it and
// `jaw chat` crashes with ERR_MODULE_NOT_FOUND (jawcode-render then degrades to
// --simple, but the rich TUI is gone).
//
// When the @jawcode-dev/tui source is resolvable (a workspace/linked checkout)
// and Bun is available, build the bundle via scripts/build-tui-bundle.mjs.
// Otherwise warn and continue — this step never fails the build; the runtime
// fallback in src/cli/tui/jawcode-render.ts covers the missing-bundle case.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const target = join(repoRoot, "src/lib/tui/jawcode-tui-bundle.mjs");

const skip = (msg) => {
	console.warn(`[ensure-tui-bundle] ${msg}`);
	console.warn("[ensure-tui-bundle] `jaw chat` will fall back to --simple line mode until the bundle is present.");
	process.exit(0);
};

if (existsSync(target)) {
	console.log("[ensure-tui-bundle] bundle already present — nothing to do.");
	process.exit(0);
}

// The bundle is built from the @jawcode-dev/tui source, which is only present in
// a workspace/linked checkout (it is not published to the public registry).
try {
	import.meta.resolve("@jawcode-dev/tui/tui");
} catch {
	skip("@jawcode-dev/tui source not found — skipping rich TUI bundle build.");
}

const built = spawnSync("bun", [join(scriptsDir, "build-tui-bundle.mjs")], { cwd: repoRoot, stdio: "inherit" });
if (built.error || built.status !== 0) skip("bundle build did not complete (is `bun` installed?) — skipping.");
if (!existsSync(target)) skip("bundle build produced no output — skipping.");
console.log(`[ensure-tui-bundle] installed ${target}`);
