#!/usr/bin/env node
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SKILLS_REPO = "https://github.com/lidge-jun/cli-jaw-skills.git";
const CLONE_COOLDOWN_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 80_000;
// Must mirror CODEX_ACTIVE + OPENCLAW_ACTIVE in lib/mcp/skills-utils.ts.
// It drifted before: search, structured-renderers, and goal were missing, so
// the desktop app activated 27 skills where the CLI activated 30.
const BASE_AUTO_ACTIVATE = new Set([
	"jaw-pdf",
	"jaw-browser",
	"jaw-memory",
	"jaw-search",
	"jaw-screen-capture",
	"jaw-docx",
	"jaw-xlsx",
	"jaw-pptx",
	"jaw-hwp",
	"jaw-github",
	"jaw-telegram-send",
	"jaw-video",
	"jaw-pdf-vision",
	"jaw-diagram",
	"jaw-structured-renderers",
	"jaw-desktop-control",
	"jaw-goal",
]);

// Pre-jaw-* names. A legacy directory is moved aside, never deleted (it may
// hold the user's own edits), and a compatibility symlink keeps literal paths
// in a customized A-1.md working for one major version.
const LEGACY_SKILL_ALIASES = new Map(
	[
		"pdf", "browser", "memory", "search", "screen-capture", "docx", "xlsx",
		"pptx", "hwp", "github", "telegram-send", "video", "pdf-vision",
		"diagram", "structured-renderers", "desktop-control", "goal",
		"dev", "dev-architecture", "dev-backend", "dev-code-reviewer", "dev-data",
		"dev-debugging", "dev-devops", "dev-frontend", "dev-pabcd",
		"dev-scaffolding", "dev-security", "dev-testing", "dev-uiux-design",
	].map((id) => [id, "jaw-" + id]),
);
const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".turbo"]);
const IGNORED_FILES = new Set([".DS_Store"]);

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const checkOnly = args.has("--check");
const postinstall = args.has("--postinstall");
const safeMode = process.env.CI === "true" || process.env.JWC_SAFE === "1";
const disabled = process.env.JWC_SKIP_CLI_JAW_BOOTSTRAP === "1";
const packageRoot = path.join(__dirname, "..");
const targetHome = resolveCliJawHome(process.env, os.homedir());
const activeDir = path.join(targetHome, "skills");
const refDir = path.join(targetHome, "skills_ref");
const cloneMetaPath = path.join(targetHome, ".skills_clone_meta.json");

function expandHome(value, homeDir) {
	if (value === "~") return homeDir;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
	return value;
}

function resolveCliJawHome(env = process.env, homeDir = os.homedir()) {
	const configured = env.CLI_JAW_HOME?.trim();
	const raw = configured && configured.length > 0 ? configured : path.join(homeDir, ".cli-jaw");
	return path.resolve(expandHome(raw, homeDir));
}

function status(pathValue, status) {
	return { path: pathValue, status };
}

function makeResult() {
	return {
		ok: false,
		targetHome,
		safeMode,
		postinstall,
		settings: status(path.join(targetHome, "settings.json"), "pending"),
		heartbeat: status(path.join(targetHome, "heartbeat.json"), "pending"),
		mcp: status(path.join(targetHome, "mcp.json"), "pending"),
		skills: {
			activeDir,
			refDir,
			status: "pending",
			source: "none",
			downloaded: false,
			activeCount: 0,
			refCount: 0,
			ignoredDirNames: [...IGNORED_DIRS],
		},
	};
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(filePath, content) {
	if (fs.existsSync(filePath)) return "exists";
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, content);
	return "written";
}

function readSettingsSeed() {
	const seedPath = path.join(packageRoot, "defaults", "cli-jaw", "settings.json");
	const text = fs.readFileSync(seedPath, "utf8").replaceAll("__CLI_JAW_HOME__", targetHome.replace(/\\/g, "\\\\"));
	JSON.parse(text);
	return text.endsWith("\n") ? text : `${text}\n`;
}

function ensureBaseHome(result, mode) {
	ensureDir(targetHome);
	if (mode === "home-only") {
		result.settings.status = "skipped";
		result.heartbeat.status = "skipped";
		result.mcp.status = "skipped";
		return;
	}
	ensureDir(path.join(targetHome, "uploads"));
	ensureDir(path.join(targetHome, "prompts"));
	result.settings.status = writeIfMissing(result.settings.path, readSettingsSeed());
	result.heartbeat.status = writeIfMissing(result.heartbeat.path, `${JSON.stringify({ jobs: [] }, null, "\t")}\n`);
	result.mcp.status = writeIfMissing(result.mcp.path, `${JSON.stringify({ servers: {} }, null, "\t")}\n`);
}

function readJson(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

function loadRegistry(dir) {
	return readJson(path.join(dir, "registry.json"), { skills: {} });
}

function countSkillDirs(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && isSkillDir(entry.name)).length;
	} catch {
		return 0;
	}
}

function isSkillDir(name) {
	return !name.startsWith(".") && !name.endsWith(".bak") && !name.endsWith("_original") && !IGNORED_DIRS.has(name);
}

function semverGt(leftValue, rightValue) {
	const left = String(leftValue ?? "").split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
	const right = String(rightValue ?? "").split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < 3; index++) {
		if (left[index] > right[index]) return true;
		if (left[index] < right[index]) return false;
	}
	return false;
}

function updateHash(hash, current, root) {
	for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		if (entry.isFile() && (IGNORED_FILES.has(entry.name) || entry.name.endsWith(".pyc"))) continue;
		if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
		const entryPath = path.join(current, entry.name);
		if (entry.isDirectory()) {
			updateHash(hash, entryPath, root);
		} else if (entry.isFile()) {
			hash.update(path.relative(root, entryPath).replace(/\\/g, "/"));
			hash.update("\0");
			hash.update(fs.readFileSync(entryPath));
			hash.update("\0");
		}
	}
}

function fingerprint(dir) {
	const hash = crypto.createHash("sha256");
	updateHash(hash, dir, dir);
	return hash.digest("hex");
}

function shouldUpdateSkill(id, src, dst, srcRegistry, dstRegistry) {
	if (!fs.existsSync(dst)) return true;
	const srcVersion = srcRegistry.skills?.[id]?.version;
	const dstVersion = dstRegistry.skills?.[id]?.version;
	if (srcVersion && (!dstVersion || semverGt(srcVersion, dstVersion))) return true;
	return fingerprint(src) !== fingerprint(dst);
}

function copyTree(src, dst) {
	ensureDir(dst);
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		if (entry.isFile() && (IGNORED_FILES.has(entry.name) || entry.name.endsWith(".pyc"))) continue;
		const srcPath = path.join(src, entry.name);
		const dstPath = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(srcPath, dstPath);
		else if (entry.isFile()) fs.copyFileSync(srcPath, dstPath);
	}
}

function mergeRef(sourceRoot) {
	ensureDir(refDir);
	const srcRegistry = loadRegistry(sourceRoot);
	const dstRegistry = loadRegistry(refDir);
	for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const srcPath = path.join(sourceRoot, entry.name);
		const dstPath = path.join(refDir, entry.name);
		if (entry.isDirectory()) {
			if (!isSkillDir(entry.name)) continue;
			if (shouldUpdateSkill(entry.name, srcPath, dstPath, srcRegistry, dstRegistry)) {
				fs.rmSync(dstPath, { recursive: true, force: true });
				copyTree(srcPath, dstPath);
			}
		} else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && !entry.name.endsWith(".pyc")) {
			fs.copyFileSync(srcPath, dstPath);
		}
	}
}

function buildAutoActivateSet() {
	const registry = loadRegistry(refDir);
	const out = new Set(BASE_AUTO_ACTIVATE);
	for (const [id, meta] of Object.entries(registry.skills ?? {})) {
		if (meta && meta.category === "orchestration") out.add(id);
	}
	return out;
}

function activateSkills() {
	const autoActivate = buildAutoActivateSet();
	const registry = loadRegistry(refDir);
	let activeCount = 0;
	for (const id of autoActivate) {
		const src = path.join(refDir, id);
		const dst = path.join(activeDir, id);
		if (!fs.existsSync(src)) continue;
		ensureDir(activeDir);
		if (shouldUpdateSkill(id, src, dst, registry, { skills: {} })) {
			fs.rmSync(dst, { recursive: true, force: true });
			copyTree(src, dst);
		}
		activeCount++;
	}
	normalizeSkillNamespace();
	return activeCount;
}

/**
 * Same two stages as lib/mcp/skills-migration.ts, in CommonJS.
 * 1. A real legacy directory is MOVED to backups/skills-conflicts/<stamp>/ —
 *    never deleted, because it may contain the user's own edits.
 * 2. skills/<legacy> -> jaw-<legacy> keeps literal paths in a customized
 *    A-1.md alive. Enumerators filter on isDirectory(), which is false for a
 *    symlink, so the link never registers as a second skill.
 */
function normalizeSkillNamespace() {
	if (!fs.existsSync(activeDir)) return;
	let backupRoot = null;
	for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
		const legacyPath = path.join(activeDir, legacyId);
		let stat = null;
		try { stat = fs.lstatSync(legacyPath); } catch { stat = null; }
		if (stat && stat.isSymbolicLink()) {
			let current = null;
			try { current = fs.readlinkSync(legacyPath); } catch { current = null; }
			if (current === canonicalId) continue;
			try { fs.unlinkSync(legacyPath); } catch { /* leave it alone */ }
		} else if (stat && stat.isDirectory()) {
			try {
				if (!backupRoot) {
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					backupRoot = path.join(targetHome, "backups", "skills-conflicts", stamp);
				}
				ensureDir(backupRoot);
				fs.renameSync(legacyPath, path.join(backupRoot, legacyId));
				console.log(`[skills] legacy skill backed up: ${legacyId}`);
			} catch (e) {
				console.warn(`[skills] could not back up ${legacyId}: ${e.message}`);
				continue;
			}
		} else if (stat) {
			continue;
		}
		if (!fs.existsSync(path.join(activeDir, canonicalId))) continue;
		try {
			fs.symlinkSync(canonicalId, legacyPath, "junction");
		} catch (e) {
			console.warn(`[skills] compat link ${legacyId} skipped: ${e.message}`);
		}
	}
}

function readCloneMeta() {
	const meta = readJson(cloneMetaPath, null);
	return meta && typeof meta.lastAttempt === "number" && typeof meta.success === "boolean" ? meta : null;
}

function writeCloneMeta(success) {
	fs.writeFileSync(cloneMetaPath, `${JSON.stringify({ lastAttempt: Date.now(), success }, null, "\t")}\n`);
}

function cloneCooldownActive() {
	if (process.env.JWC_FORCE_CLI_JAW_SKILLS === "1" || process.env.JAW_FORCE_CLONE === "1") return false;
	const meta = readCloneMeta();
	return Boolean(meta && !meta.success && fs.existsSync(path.join(refDir, "registry.json")) && Date.now() - meta.lastAttempt < CLONE_COOLDOWN_MS);
}

function cloneSkillsRepo() {
	if (cloneCooldownActive()) return undefined;
	const repo = process.env.JWC_CLI_JAW_SKILLS_REPO || DEFAULT_SKILLS_REPO;
	const tmp = path.join(targetHome, ".skills_clone_tmp");
	fs.rmSync(tmp, { recursive: true, force: true });
	try {
		childProcess.execFileSync("git", ["clone", "--depth", "1", repo, tmp], { stdio: "ignore", timeout: CLONE_TIMEOUT_MS });
		writeCloneMeta(true);
		return tmp;
	} catch (error) {
		writeCloneMeta(false);
		throw error;
	}
}

function bootstrapSkills(result) {
	if (safeMode) {
		const hasExistingRef = fs.existsSync(path.join(refDir, "registry.json"));
		result.skills.status = "safe-skipped";
		result.skills.source = hasExistingRef ? "existing" : "none";
		if (hasExistingRef) {
			result.skills.activeCount = activateSkills();
			result.skills.refCount = countSkillDirs(refDir);
		}
		return;
	}
	const localSource = process.env.JWC_CLI_JAW_SKILLS_SOURCE_DIR;
	let sourceRoot;
	let sourceKind = "none";
	let tmpClone;
	try {
		if (localSource) {
			sourceRoot = path.resolve(expandHome(localSource, os.homedir()));
			sourceKind = "local-fixture";
		} else {
			tmpClone = cloneSkillsRepo();
			if (tmpClone) {
				sourceRoot = tmpClone;
				sourceKind = "github";
				result.skills.downloaded = true;
			}
		}
		if (sourceRoot && fs.existsSync(sourceRoot)) {
			mergeRef(sourceRoot);
			result.skills.status = "written";
			result.skills.source = sourceKind;
		} else if (fs.existsSync(path.join(refDir, "registry.json"))) {
			result.skills.status = "exists";
			result.skills.source = "existing";
		} else {
			result.skills.status = "skipped";
			result.skills.source = "none";
		}
		result.skills.activeCount = activateSkills();
		result.skills.refCount = countSkillDirs(refDir);
	} catch (error) {
		result.skills.status = postinstall ? "failed-nonfatal" : "failed";
		result.skills.error = error instanceof Error ? error.message : String(error);
		result.skills.source = fs.existsSync(path.join(refDir, "registry.json")) ? "existing" : sourceKind;
		if (result.skills.source === "existing") {
			result.skills.activeCount = activateSkills();
			result.skills.refCount = countSkillDirs(refDir);
		}
	} finally {
		if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true });
	}
}

function checkResult(result) {
	result.settings.status = fs.existsSync(result.settings.path) ? "exists" : result.settings.status;
	result.heartbeat.status = fs.existsSync(result.heartbeat.path) ? "exists" : result.heartbeat.status;
	result.mcp.status = fs.existsSync(result.mcp.path) ? "exists" : result.mcp.status;
	result.skills.refCount = countSkillDirs(refDir);
	result.skills.activeCount = countSkillDirs(activeDir);
	if (fs.existsSync(path.join(refDir, "registry.json"))) result.skills.source = "existing";
	if (result.skills.status === "pending") result.skills.status = result.skills.refCount > 0 ? "exists" : "missing";
	result.ok = fs.existsSync(result.settings.path) && fs.existsSync(result.heartbeat.path) && fs.existsSync(result.mcp.path) && fs.existsSync(path.join(refDir, "registry.json")) && result.skills.activeCount > 0;
}

function run() {
	const result = makeResult();
	if (disabled) {
		if (!checkOnly && postinstall) ensureBaseHome(result, "home-only");
		result.skills.status = "skipped";
		result.skills.source = "none";
		if (checkOnly) {
			checkResult(result);
			result.ok = false;
			result.status = "skipped-not-ready";
		} else {
			result.ok = postinstall;
		}
		return result;
	}
	if (checkOnly) {
		checkResult(result);
		return result;
	}
	ensureBaseHome(result, "normal");
	bootstrapSkills(result);
	checkResult(result);
	if (postinstall && result.skills.status === "failed-nonfatal") result.ok = true;
	return result;
}

function printHuman(result) {
	const prefix = postinstall ? "[jwc:init]" : "jwc cli-jaw bootstrap";
	if (result.ok) {
		process.stdout.write(`${prefix} cli-jaw home ready: ${result.targetHome}\n`);
		return;
	}
	const message = result.skills.error ? ` (${result.skills.error})` : "";
	const text = `${prefix} cli-jaw home not fully ready: skills=${result.skills.status}${message}\n`;
	(postinstall ? process.stdout : process.stderr).write(text);
	if (postinstall) {
		process.stdout.write(`${prefix} remediation: run \`npm rebuild jawcode\` or \`node ${__filename} --check --json\` from the installed package.\n`);
	}
}

let result;
try {
	result = run();
} catch (error) {
	result = makeResult();
	result.ok = false;
	result.error = error instanceof Error ? error.message : String(error);
	if (postinstall) result.ok = true;
}

if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else printHuman(result);
process.exit(result.ok || postinstall ? 0 : 1);
