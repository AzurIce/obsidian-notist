import { Notice, TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { getCM, vim } from "@replit/codemirror-vim";
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
	/**
	 * Vim normal/visual mode runs with contenteditable off so the OS never
	 * routes keystrokes to the IME (IMEs only engage editable contexts).
	 * editable=false makes the content div unfocusable, so tabindex=0 is
	 * kept on permanently below (also: removing tabindex from a focused
	 * element blurs it in Chrome).
	 */
	private static vimNonEditable: Extension = EditorView.editable.of(false);

	private titleInputEl: HTMLInputElement | null = null;
	private editorView: EditorView | null = null;
	/** Suppresses requestSave while setViewData is replacing the doc. */
	private settingData = false;
	private vimCompartment = new Compartment();
	private editableCompartment = new Compartment();
	/** The CM5-shim instance our vim-mode-change listener is attached to. */
	private vimListenerCm: object | null = null;

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
		const vimMode = this.plugin.data.vimMode;
		this.editorView = new EditorView({
			parent: editorWrapEl,
			state: EditorState.create({
				extensions: [
					// vim() must precede the other keymaps so its bindings win.
					this.vimCompartment.of(vimMode ? vim() : []),
					// Vim starts in normal mode: begin non-editable (no IME).
					this.editableCompartment.of(
						vimMode ? NotistTextView.vimNonEditable : [],
					),
					// Visual-block mode (C-v) and vim multi-cursor need CM
					// multi-selection; CM defaults to a single range and
					// would silently clip per-line block selections.
					EditorState.allowMultipleSelections.of(true),
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightActiveLine(),
					// CM-drawn caret/selection: the vim extension is built for
					// drawSelection (it hides CM's cursor layer in normal mode);
					// without it insert mode depends on the flaky native caret.
					drawSelection(),
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						spellcheck: "false",
						tabindex: "0",
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !this.settingData) this.requestSave();
					}),
				],
			}),
		});

		if (vimMode) this.ensureVimModeListener();

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
		if (!this.editorView) return;
		this.editorView.dispatch({
			effects: [
				this.vimCompartment.reconfigure(enabled ? vim() : []),
				this.editableCompartment.reconfigure(
					enabled ? NotistTextView.vimNonEditable : [],
				),
			],
		});
		if (enabled) this.ensureVimModeListener();
	}

	/**
	 * Follow vim mode changes: editable only while typing (insert/replace),
	 * non-editable otherwise so the IME never engages in normal/visual.
	 * getCM() returns a fresh CM5-shim each time vim() is reconfigured, so
	 * re-attach when the instance changes.
	 */
	private ensureVimModeListener(): void {
		const view = this.editorView;
		if (!view) return;
		const cm = getCM(view);
		if (!cm || cm === this.vimListenerCm) return;
		this.vimListenerCm = cm;
		cm.on("vim-mode-change", (e: { mode: string }) => {
			const typing = e.mode === "insert" || e.mode === "replace";
			// This event can fire while a CM update is in progress (mode
			// changes triggered by a transaction); dispatching then throws
			// and the editable compartment desyncs from vim's real mode —
			// the editor gets stuck (can't type, can't exit insert). Defer.
			setTimeout(() => {
				const view = this.editorView;
				if (!view) return;
				view.dispatch({
					effects: this.editableCompartment.reconfigure(
						typing ? [] : NotistTextView.vimNonEditable,
					),
				});
				// Flipping contenteditable on a focused element can blur it
				// in Chrome; the mode change came from an editor keypress,
				// so the editor should keep focus.
				if (!view.hasFocus) view.contentDOM.focus();
			}, 0);
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
