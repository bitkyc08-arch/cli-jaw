// Build the standalone Node bundle the rich `jaw chat` TUI loads, from the
// @jawcode-dev/tui source. Run via scripts/ensure-tui-bundle.mjs (which checks
// preconditions first). Must run under Bun (uses Bun.build).
//
//   - @jawcode-dev/natives stays external so its Node-compatible loader resolves
//     the prebuilt addon at runtime — nothing machine-specific is baked in.
//   - bun:ffi and @jawcode-dev/utils are swapped for the small shims in
//     ./tui-bundle, keeping winston/handlebars/mermaid out of the artifact.
//
// The `Bun` global the sources rely on is installed at runtime by bun-shim.mjs.
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outFile = join(repoRoot, "src/lib/tui/jawcode-tui-bundle.mjs");
const shim = (p) => join(here, "tui-bundle", p);

const result = await Bun.build({
	entrypoints: [shim("entry.mts")],
	target: "node",
	format: "esm",
	plugins: [
		{
			name: "node-standalone-shims",
			setup(build) {
				build.onResolve({ filter: /^@jawcode-dev\/natives$/ }, () => ({
					path: "@jawcode-dev/natives",
					external: true,
				}));
				build.onResolve({ filter: /^@jawcode-dev\/utils$/ }, () => ({ path: shim("utils-shim.ts") }));
				build.onResolve({ filter: /^bun:ffi$/ }, () => ({ path: shim("bun-ffi-shim.ts") }));
			},
		},
	],
});

if (!result.success) {
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}

await mkdir(dirname(outFile), { recursive: true });
await Bun.write(outFile, await result.outputs[0].text());
console.log(`[build-tui-bundle] wrote ${outFile}`);
