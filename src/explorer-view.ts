import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";

export const VIEW_TYPE_NOTIST_EXPLORER = "notist-explorer";

/**
 * Notist World's own file tree: lists only .not files.
 * Flat path-sorted list for now; module-structure grouping comes later
 * (data will eventually come from notist-service, not raw vault files).
 */
export class NotistExplorerView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_NOTIST_EXPLORER;
	}

	getDisplayText(): string {
		return "Notist explorer";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		this.render();
		const refresh = () => this.render();
		this.registerEvent(this.app.vault.on("create", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("notist-explorer");

		const header = container.createDiv("notist-explorer-header");
		const newFileBtn = header.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "New .not file" },
		});
		setIcon(newFileBtn, "file-plus");
		newFileBtn.addEventListener("click", () => void this.createFile());
		const newFolderBtn = header.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "New folder" },
		});
		setIcon(newFolderBtn, "folder-plus");
		newFolderBtn.addEventListener("click", () => void this.createFolder());

		const files = this.app.vault
			.getFiles()
			.filter((f: TFile) => f.extension === "not")
			.sort((a, b) => a.path.localeCompare(b.path));

		if (files.length === 0) {
			container.createDiv("notist-explorer-empty").setText(
				"No .not files in this vault.",
			);
			return;
		}

		const list = container.createEl("ul", { cls: "notist-explorer-list" });
		for (const file of files) {
			const item = list.createEl("li", { cls: "notist-explorer-item" });
			item.setText(file.path);
			item.addEventListener("click", () => {
				void this.app.workspace.getLeaf(false).openFile(file);
			});
		}
	}

	private nextAvailablePath(base: string, ext = ""): string {
		let candidate = `${base}${ext}`;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${base} ${i++}${ext}`;
		}
		return candidate;
	}

	private async createFile(): Promise<void> {
		const path = this.nextAvailablePath("Untitled", ".not");
		const file = await this.app.vault.create(path, "");
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private async createFolder(): Promise<void> {
		await this.app.vault.createFolder(this.nextAvailablePath("New folder"));
	}
}
