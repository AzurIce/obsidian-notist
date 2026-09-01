/**
 * Vendor the notist site assets the preview view composes its iframe from:
 * the site stylesheet and the plugin web-component modules.
 *
 * Runs `notist build` against a Notist vault, then copies `_notist/style.css`
 * and `_notist/plugins/` from the built site into `assets/site/`. Refresh on
 * the same cadence as the highlight wasm assets (after pulling a new notist).
 *
 * Usage: bun run assets:site [vault-path]
 *   vault defaults to $NOTIST_PATH/docs; the binary comes from
 *   $NOTIST_COMMAND or PATH; missing environment falls back to the repo .env.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const pluginRoot = resolve(import.meta.dir, "..");
const outDir = join(pluginRoot, "assets", "site");

/** Expands a leading `~` (env-injected values may carry it unexpanded). */
function expandTilde(value: string): string {
	return value.replace(/^~/, process.env.HOME ?? "~");
}

/** Reads an env var, falling back to the repo `.env` (this script runs
 * outside direnv like every other shell entry point). */
function envValue(name: string): string | null {
	if (process.env[name]) return expandTilde(process.env[name]!);
	const envFile = join(pluginRoot, ".env");
	if (!existsSync(envFile)) return null;
	for (const line of readFileSync(envFile, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
		if (match?.[1] === name) return expandTilde(match[2].replace(/^"(.*)"$/, "$1"));
	}
	return null;
}

const notistCommand = envValue("NOTIST_COMMAND") ?? "notist";
const vaultRaw = process.argv[2]
	? expandTilde(process.argv[2])
	: (envValue("NOTIST_PATH") ? `${envValue("NOTIST_PATH")}/docs` : null);
if (!vaultRaw) {
	console.error("error: no vault — pass a path or set NOTIST_PATH (see .env)");
	process.exit(1);
}
const vault = resolve(vaultRaw);
if (!existsSync(join(vault, "Notist.toml"))) {
	console.error(`error: ${vault} does not look like a Notist vault (no Notist.toml)`);
	process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "notist-site-"));
try {
	// Newer notist takes a global `--vault <dir>`; older builds take the root
	// as a trailing `[ROOT]` positional. Some CLIs exit nonzero on benign
	// diagnostics, so success is judged by the artifact, not the exit code.
	const baseArgs = ["build", "--output", staging, "--clean"];
	const attempt = (args: string[], visible: boolean): boolean => {
		try {
			execFileSync(notistCommand, args, { stdio: visible ? "inherit" : "ignore" });
			return true;
		} catch {
			return existsSync(join(staging, "_notist", "style.css"));
		}
	};
	if (!attempt(["--vault", vault, ...baseArgs], false) && !attempt([...baseArgs, vault], true)) {
		console.error("error: notist build did not produce _notist/style.css");
		process.exit(1);
	}
	const siteDir = join(staging, "_notist");
	if (!existsSync(join(siteDir, "style.css"))) {
		console.error("error: build output has no _notist/style.css");
		process.exit(1);
	}
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	cpSync(join(siteDir, "style.css"), join(outDir, "style.css"));
	if (existsSync(join(siteDir, "plugins"))) {
		cpSync(join(siteDir, "plugins"), join(outDir, "plugins"), { recursive: true });
	}
	const version = execFileSync(notistCommand, ["--version"]).toString().trim().replace(/^notist\s+/, "");
	writeFileSync(
		join(outDir, "UPSTREAM.txt"),
		`${version}\nfrom vault: ${vault}\nfetched: ${new Date().toISOString()}\n`,
	);
	console.log(`vendored site assets into assets/site (notist ${version})`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
