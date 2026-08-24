import { Notice, TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import { Compartment, EditorState } from "@codemirror/state";
import {
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import type NotistPlugin from "./main";

export const VIEW_TYPE_NOTIST = "notist-view";

/**
 * Plain-text editor for .not files, backed by a minimal CodeMirror 6
 * (line numbers, soft wrap, history; Obsidian provides the CM runtime).
 * Intentionally minimal: no notist parser/LSP yet.
 * Has an inline title (like the markdown view) that renames the file.
 * Vim keybindings are optional (plugin setting), toggled live via a
 * Compartment so open editors pick the change up without a reload.
 */
export class NotistTextView extends TextFileView {
	private titleInputEl: HTMLInputElement | null = null;
	private editorView: EditorView | null = null;
	/** Suppresses requestSave while setViewData is replacing the doc. */
	private settingData = false;
	private vimCompartment = new Compartment();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: NotistPlugin,
	) {
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

		const editorWrapEl = this.contentEl.createDiv("notist-editor");
		this.editorView = new EditorView({
			parent: editorWrapEl,
			state: EditorState.create({
				extensions: [
					// vim() must precede the other keymaps so its bindings win.
					this.vimCompartment.of(
						this.plugin.data.vimMode ? vim() : [],
					),
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightActiveLine(),
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ spellcheck: "false" }),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !this.settingData) this.requestSave();
					}),
				],
			}),
		});

		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (this.file && file.path === this.file.path) this.syncTitle();
			}),
		);
	}

	async onClose(): Promise<void> {
		this.editorView?.destroy();
		this.editorView = null;
		this.contentEl.empty();
		this.titleInputEl = null;
	}

	/** Focus the inline title with the basename selected (post-create rename UX). */
	startRename(): void {
		this.titleInputEl?.focus();
		this.titleInputEl?.select();
	}

	/** Toggle vim keybindings live (called from the settings tab). */
	setVimMode(enabled: boolean): void {
		this.editorView?.dispatch({
			effects: this.vimCompartment.reconfigure(enabled ? vim() : []),
		});
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
		return this.editorView?.state.doc.toString() ?? "";
	}

	setViewData(data: string, _clear: boolean): void {
		const view = this.editorView;
		if (view && data !== view.state.doc.toString()) {
			this.settingData = true;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: data },
			});
			this.settingData = false;
		}
		this.syncTitle();
	}

	clear(): void {
		this.setViewData("", true);
	}
}
