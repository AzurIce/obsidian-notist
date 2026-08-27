/**
 * Install this plugin into an Obsidian vault's plugins directory.
 *
 * Default: copy the built artifacts (committable, self-contained vault).
 * --link:  symlink the whole repo directory instead (live dev loop).
 *
 * Usage: bun run sync [--link] <vault-path>  (runs build first; copies artifacts)
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const pluginId = "obsidian-notist";
const artifacts = ["manifest.json", "main.js", "styles.css"];
/** Shipped verbatim and loaded at runtime (wasm grammar + highlight query). */
const assetDirs = ["assets"];

const args = process.argv.slice(2);
const link = args.includes("--link");
const vaultArg = args.find((a) => a !== "--link");
if (!vaultArg) {
	console.error("usage: bun run sync [--link] <vault-path>");
	process.exit(1);
}
const vault = resolve(vaultArg.replace(/^~/, process.env.HOME ?? "~"));

if (!existsSync(join(vault, ".obsidian"))) {
	console.error(`error: ${vault} does not look like an Obsidian vault (no .obsidian/)`);
	process.exit(1);
}
for (const f of artifacts) {
	if (!existsSync(join(pluginRoot, f))) {
		console.error(`error: ${f} missing — run \`bun run build\` first (or use \`bun run sync\`)`);
		process.exit(1);
	}
}
for (const d of assetDirs) {
	if (!existsSync(join(pluginRoot, d))) {
		console.error(`error: ${d}/ missing — highlight assets are required`);
		process.exit(1);
	}
}

const pluginsDir = join(vault, ".obsidian", "plugins");
mkdirSync(pluginsDir, { recursive: true });
const target = join(pluginsDir, pluginId);
let preservedData: Buffer | null = null;

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
	const stat = lstatSync(target);
	if (stat.isSymbolicLink()) {
		const current = readlinkSync(target);
		if (link && resolve(pluginsDir, current) === pluginRoot) {
			console.log(`already installed (link): ${target} -> ${current}`);
			process.exit(0);
		}
		const dataPath = join(target, "data.json");
		if (existsSync(dataPath)) preservedData = readFileSync(dataPath);
		rmSync(target);
		console.log(`replaced existing symlink (was -> ${current})`);
	} else if (link) {
		console.error(
			`error: ${target} exists and is not a symlink; refusing to remove a real directory`,
		);
		process.exit(1);
	}
}

if (link) {
	symlinkSync(pluginRoot, target, "dir");
	console.log(`installed (link): ${target} -> ${pluginRoot}`);
} else {
	// Obsidian stores plugin settings in target/data.json. Refresh only the
	// files managed by this installer so syncing another worktree cannot
	// erase settings (or any other runtime-owned files).
	mkdirSync(target, { recursive: true });
	for (const f of artifacts) copyFileSync(join(pluginRoot, f), join(target, f));
	for (const d of assetDirs) {
		rmSync(join(target, d), { recursive: true, force: true });
		cpSync(join(pluginRoot, d), join(target, d), { recursive: true });
	}
	console.log(`installed (copy): ${target} [${[...artifacts, ...assetDirs].join(", ")}]`);
}
if (preservedData) {
	writeFileSync(join(target, "data.json"), preservedData);
	console.log("preserved plugin settings (data.json)");
}
console.log("next: restart Obsidian (or reload), then enable 'Notist' in Settings → Community plugins");
