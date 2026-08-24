import { Notice, TFile, TextFileView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_NOTIST = "notist-view";

/**
 * Plain-text editor for .not files.
 * Intentionally minimal: no notist parser/LSP yet, just bytes in a textarea.
 * Has an inline title (like the markdown view) that renames the file.
 */
export class NotistTextView extends TextFileView {
	private titleInputEl: HTMLInputElement | null = null;
	private editorEl: HTMLTextAreaElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_NOTIST;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "notist";
	}

	getIcon(): string {
		return "file-text";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notist-view-root");
		this.titleInputEl = this.contentEl.createEl("input", {
			cls: "notist-title",
			attr: { type: "text", spellcheck: "false" },
		});
		this.titleInputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") this.titleInputEl?.blur();
			else if (evt.key === "Escape") {
				this.syncTitle();
				this.titleInputEl?.blur();
			}
		});
		this.titleInputEl.addEventListener("blur", () => void this.commitTitle());

		this.editorEl = this.contentEl.createEl("textarea", {
			cls: "notist-editor",
		});
		this.editorEl.spellcheck = false;
		this.editorEl.addEventListener("input", () => this.requestSave());

		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (this.file && file.path === this.file.path) this.syncTitle();
			}),
		);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		this.titleInputEl = null;
		this.editorEl = null;
	}

	/** Focus the inline title with the basename selected (post-create rename UX). */
	startRename(): void {
		this.titleInputEl?.focus();
		this.titleInputEl?.select();
	}

	private syncTitle(): void {
		if (this.titleInputEl && this.file) this.titleInputEl.value = this.file.basename;
	}

	private async commitTitle(): Promise<void> {
		const file = this.file;
		if (!file || !this.titleInputEl) return;
		const name = this.titleInputEl.value.trim();
		if (!name || name === file.basename) {
			this.syncTitle();
			return;
		}
		const dir = file.parent?.path;
		const newPath = `${dir && dir !== "/" ? `${dir}/` : ""}${name}.not`;
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`Notist: "${name}.not" already exists`);
			this.syncTitle();
			return;
		}
		await this.app.fileManager.renameFile(file, newPath);
	}

	getViewData(): string {
		return this.editorEl?.value ?? "";
	}

	setViewData(data: string, _clear: boolean): void {
		if (this.editorEl) this.editorEl.value = data;
		this.syncTitle();
	}

	clear(): void {
		if (this.editorEl) this.editorEl.value = "";
	}
}
