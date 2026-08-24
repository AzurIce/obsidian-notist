import { App, PluginSettingTab, Setting } from "obsidian";
import type NotistPlugin from "./main";

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
