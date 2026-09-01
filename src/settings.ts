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
			.setName("Default view mode")
			.setDesc("Mode used when a .not file opens in a new tab (the " +
				"per-tab toggle lives in the tab header).")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						source: "Editing view",
						preview: "Reading view",
					})
					.setValue(this.plugin.data.defaultViewMode)
					.onChange(async (value) => {
						await this.plugin.setDefaultViewMode(
							value === "preview" ? "preview" : "source",
						);
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
			.setName("notist command")
			.setDesc(
				"Command used to invoke the notist CLI — the plugin appends the " +
					"subcommand itself (`lsp` for the language server; the same " +
					"command will back future `build` etc. calls). Whitespace-" +
					"separated, quote parts that contain spaces; not a shell (`~`, " +
					"$VAR and globs stay literal). Default: `notist`. The server " +
					"runs with the vault as its working directory; launchers that " +
					"need their own cwd say so in the command — e.g. dev build: " +
					"`nix develop /path/to/notist -c cargo run --manifest-path " +
					"/path/to/notist/Cargo.toml`. A `--` before the subcommand is " +
					"inserted automatically for wrapper launchers (`nix`, `cargo`, " +
					"`npm`, …) unless the command already contains one.",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.data.notistCommand)
					.onChange(
						debounce(async (value: string) => {
							await this.plugin.setNotistCommand(value.trim() || "notist");
						}, 800),
					),
			);

		new Setting(containerEl)
			.setName("notist extra arguments")
			.setDesc(
				"Appended after the subcommand on every invocation (the language " +
					"server runs `… lsp`). Example: `--no-daemon` embeds the service " +
					"in the server process instead of the shared per-vault daemon. " +
					"Default: empty.",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.data.notistExtraArgs)
					.onChange(
						debounce(async (value: string) => {
							await this.plugin.setNotistExtraArgs(value.trim());
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
