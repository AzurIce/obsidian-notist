import { App, PluginSettingTab, Setting } from "obsidian";
import type NotistPlugin from "./main";

/** Text inputs fire onChange per keystroke; restart-triggering settings must
 * not react until the user pauses typing. */
function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	ms: number,
): (...args: A) => void {
	let timer: number | null = null;
	return (...args: A) => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			fn(...args);
		}, ms);
	};
}

export class NotistSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: NotistPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Vim keybindings")
			.setDesc("Enable vim keybindings in the .not editor.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.data.vimMode)
					.onChange(async (value) => {
						await this.plugin.setVimMode(value);
					}),
			);

		new Setting(containerEl)
			.setName("Language server (desktop)")
			.setDesc(
				"Spawn `notist lsp` for diagnostics, completion, hover and " +
					"go-to-definition in the .not editor. Requires the notist " +
					"binary; off by default.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.data.lspEnabled)
					.onChange(async (value) => {
						await this.plugin.setLspEnabled(value);
					}),
			);

		new Setting(containerEl)
			.setName("notist binary path")
			.setDesc(
				"Command or absolute path used to start the language server " +
					"(default: `notist` from PATH).",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.data.lspBinaryPath)
					.onChange(
						debounce(async (value: string) => {
							await this.plugin.setLspBinaryPath(value.trim() || "notist");
						}, 800),
					),
			);

		new Setting(containerEl)
			.setName("notist binary arguments")
			.setDesc(
				"Full argv after the binary, space-separated (Zed-style: this " +
					"replaces the whole argument list, so it must include the " +
					"`lsp` subcommand). Default: `lsp`. The server runs with " +
					"the vault as its working directory; launchers that need " +
					"their own cwd must say so in argv — e.g. dev build: path " +
					"`nix`, arguments `develop /path/to/notist -c cargo run " +
					"--manifest-path /path/to/notist/Cargo.toml -- lsp`.",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.data.lspBinaryArgs.join(" "))
					.onChange(
						debounce(async (value: string) => {
							const args = value.trim().split(/\s+/).filter(Boolean);
							await this.plugin.setLspBinaryArgs(
								args.length ? args : ["lsp"],
							);
						}, 800),
					),
			);

		new Setting(containerEl)
			.setName("Ribbon icons kept in Notist world")
			.setDesc(
				"One aria-label per line (hover a ribbon icon to see its label). " +
					"All other ribbon icons are hidden while in the Notist world. " +
					"Note: labels follow the Obsidian UI language.",
			)
			.addTextArea((text) =>
				text
					.setValue(this.plugin.data.ribbonKeep.join("\n"))
					.onChange(async (value) => {
						this.plugin.data.ribbonKeep = value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.savePluginData();
						this.plugin.tagRibbon();
					}),
			);
	}
}
