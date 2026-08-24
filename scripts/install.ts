/**
 * Install this plugin into an Obsidian vault's plugins directory.
 *
 * Default: copy the built artifacts (committable, self-contained vault).
 * --link:  symlink the whole repo directory instead (live dev loop).
 *
 * Usage: bun run install [--link] <vault-path>
 */
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const pluginId = "obsidian-notist";
const artifacts = ["manifest.json", "main.js", "styles.css"];

const args = process.argv.slice(2);
const link = args.includes("--link");
const vaultArg = args.find((a) => a !== "--link");
if (!vaultArg) {
	console.error("usage: bun run install [--link] <vault-path>");
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

const pluginsDir = join(vault, ".obsidian", "plugins");
mkdirSync(pluginsDir, { recursive: true });
const target = join(pluginsDir, pluginId);

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
	const stat = lstatSync(target);
	if (stat.isSymbolicLink()) {
		const current = readlinkSync(target);
		if (link && resolve(pluginsDir, current) === pluginRoot) {
			console.log(`already installed (link): ${target} -> ${current}`);
			process.exit(0);
		}
		rmSync(target);
		console.log(`replaced existing symlink (was -> ${current})`);
	} else if (link) {
		console.error(
			`error: ${target} exists and is not a symlink; refusing to remove a real directory`,
		);
		process.exit(1);
	} else {
		// copy mode: refresh our own previously-copied directory
		rmSync(target, { recursive: true });
	}
}

if (link) {
	symlinkSync(pluginRoot, target, "dir");
	console.log(`installed (link): ${target} -> ${pluginRoot}`);
} else {
	mkdirSync(target);
	for (const f of artifacts) copyFileSync(join(pluginRoot, f), join(target, f));
	console.log(`installed (copy): ${target} [${artifacts.join(", ")}]`);
}
console.log("next: restart Obsidian (or reload), then enable 'Notist' in Settings → Community plugins");
