import {
	HoverParent,
	HoverPopover,
	Notice,
	TFile,
	TextFileView,
	WorkspaceLeaf,
	moment,
	type MarkdownFileInfo,
} from "obsidian";
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
import { notistHighlight } from "./highlight";
import { notistImageHover, isImageExtension, type ImageRefHover } from "./image-hover";
import { notistRefJump } from "./ref-jump";
import {
	applyLspDiagnostics,
	offsetFromPos,
	posFromOffset,
} from "./lsp/cm";
import type { LspDiagnostic, LspRange } from "./lsp/protocol";
import type NotistPlugin from "./main";
import { NotistEditorAdapter } from "./editor-adapter";

export const VIEW_TYPE_NOTIST = "notist-view";

/**
 * Plain-text editor for .not files, backed by a minimal CodeMirror 6
 * (line numbers, soft wrap, history; Obsidian provides the CM runtime).
 * Syntax highlighting comes from tree-sitter (highlight.ts); optional LSP
 * semantics (diagnostics/completion/hover/definition) mount through the
 * lspCompartment (lsp/cm.ts) when the server is enabled and running.
 * Has an inline title (like the markdown view) that renames the file.
 * Vim keybindings are optional (plugin setting), toggled live via a
 * Compartment so open editors pick the change up without a reload.
 */
export class NotistTextView extends TextFileView implements HoverParent {
	/**
	 * Vim normal/visual mode runs with contenteditable off so the OS never
	 * routes keystrokes to the IME (IMEs only engage editable contexts).
	 * editable=false makes the content div unfocusable, so tabindex=0 is
	 * kept on permanently below (also: removing tabindex from a focused
	 * element blurs it in Chrome).
	 */
	private static vimNonEditable: Extension = EditorView.editable.of(false);

	/** HoverParent contract: the popover itself assigns this in onShow and
	 * clears it in onHide — never write it from the view side, or onShow's
	 * "hide the previous popover" step will hide our own popover at show
	 * time (observed: constructed, img inside, never attached to the DOM). */
	hoverPopover: HoverPopover | null = null;
	/** Our own bookkeeping for the image preview, safe to replace/hide
	 * freely (may still be in its pre-show wait when the pointer moves on). */
	private imagePopover: HoverPopover | null = null;

	private titleInputEl: HTMLInputElement | null = null;
	private editorView: EditorView | null = null;
	private editorAdapter: NotistEditorAdapter | null = null;
	/** Suppresses requestSave and LSP forwarding while setViewData replaces the doc. */
	private settingData = false;
	private vimCompartment = new Compartment();
	private editableCompartment = new Compartment();
	private lspCompartment = new Compartment();
	/** Vault-relative path this view is registered under in the LSP session. */
	lspPath: string | null = null;
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
					// tree-sitter highlighting; [] when wasm init failed.
					notistHighlight(),
					// Image-reference hover previews (shell glue below).
					notistImageHover({
						show: (hover) => this.showImageHover(hover),
					}),
					// Ctrl/Cmd-click to follow any #<...> reference.
					notistRefJump({
						follow: (target, pos) => this.followRef(target, pos),
					}),
					// LSP (diagnostics/completion/hover/definition); [] when
					// the server is disabled or failed to start.
					this.lspCompartment.of(this.plugin.lspExtension(this)),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						spellcheck: "false",
						tabindex: "0",
					}),
					EditorView.domEventHandlers({
						paste: (event) => this.handlePaste(event),
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !this.settingData) {
							this.requestSave();
							this.plugin.lspDocChanged(this);
						}
						// Caret tracking for semantic panels (outline highlight).
						if (!this.settingData && (update.selectionSet || update.docChanged)) {
							this.plugin.notifyViewCursor(this, update.view);
						}
					}),
				],
			}),
		});
		this.editorAdapter = new NotistEditorAdapter(this.editorView);

		if (vimMode) this.ensureVimModeListener();

		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (this.file && file.path === this.file.path) this.syncTitle();
			}),
		);
	}

	async onClose(): Promise<void> {
		this.plugin.lspViewClosed(this);
		this.hideImagePopover();
		this.editorView?.destroy();
		this.editorView = null;
		this.editorAdapter = null;
		this.contentEl.empty();
		this.titleInputEl = null;
	}

	/** Hover preview for image resource references (`#<…>.png`): resolve the
	 * target to a vault image and show it in a native HoverPopover. The
	 * default waitTime (300ms) matters — it is also the native hide grace,
	 * so the popover survives pointer jitter instead of vanishing instantly. */
	private showImageHover(hover: ImageRefHover): void {
		const file = this.resolveResourceReference(hover.target);
		if (!file || !isImageExtension(file.extension)) return;
		this.hideImagePopover();
		const popover = new HoverPopover(this, hover.targetEl);
		const img = popover.hoverEl.createEl("img", {
			cls: "notist-image-hover",
			attr: { alt: file.name },
		});
		img.src = this.app.vault.getResourcePath(file);
		this.imagePopover = popover;
	}

	/** Ctrl/Cmd-click on a `#<...>` reference: resource files (images,
	 * attachments) open directly; everything else goes through the LSP
	 * definition (module files, headings with range reveal), falling back
	 * to client-side module-file resolution while the server is off. */
	private followRef(target: string, pos: number): void {
		const resource = this.resolveResourceReference(target);
		if (resource) {
			void this.app.workspace.getLeaf(false).openFile(resource);
			return;
		}
		void this.followDefinitionRef(target, pos);
	}

	private async followDefinitionRef(
		target: string,
		pos: number,
	): Promise<void> {
		const doc = this.editorView?.state.doc;
		if (doc) {
			const loc = await this.plugin.lspDefinition(
				this,
				posFromOffset(doc, pos),
			);
			if (loc) {
				await this.plugin.openLspLocation(loc);
				return;
			}
		}
		this.openModuleFallback(target);
	}

	/** LSP-off fallback for module refs: resolve the module path by the
	 * D0004 directory layout and open its source file (`dir/stem.not` or
	 * `dir/README.not`). */
	private openModuleFallback(target: string): void {
		const body = target.trim();
		const slash = body.indexOf("/");
		const reference = (slash < 0 ? body : body.slice(0, slash)).trim();
		const segments = this.resolveModuleSegments(reference);
		if (!segments) {
			new Notice("Notist: cannot resolve reference target");
			return;
		}
		const dir = segments.filter(Boolean).join("/");
		const candidates = dir
			? [`${dir}.not`, `${dir}/README.not`]
			: ["README.not"];
		for (const candidate of candidates) {
			const found = this.app.vault.getAbstractFileByPath(candidate);
			if (found instanceof TFile) {
				void this.app.workspace.getLeaf(false).openFile(found);
				return;
			}
		}
		new Notice("Notist: cannot resolve reference target");
	}

	/** Take down the current preview popover. HoverPopover.hide is
	 * runtime-only (absent from obsidian.d.ts); unload() is the typed
	 * teardown fallback. Safe on a popover that never showed. */
	private hideImagePopover(): void {
		const popover = this.imagePopover;
		this.imagePopover = null;
		if (!popover) return;
		const hide = (popover as { hide?: () => void }).hide;
		if (typeof hide === "function") hide.call(popover);
		else popover.unload();
	}

	/** Resolves a module reference (the `ModulePath` part of a target, `::`-
	 * separated, with `vault::`/`self::`/`super::` prefixes) into the
	 * vault-relative directory segments of the target module, mirroring
	 * notist's `ModuleReference::resolve_from` against this document's
	 * module path. Null when the reference cannot resolve. */
	private resolveModuleSegments(reference: string): string[] | null {
		const segments = reference.split("::").map((segment) => segment.trim());
		if (segments.some((segment) => !segment)) return null;
		// Current module logical path (README.not IS the directory module).
		const docDir = this.file?.parent?.path ?? "";
		const dirSegments = docDir && docDir !== "/" ? docDir.split("/") : [];
		const stem = this.file?.basename ?? "";
		const current =
			stem.toLowerCase() === "readme" ? dirSegments : [...dirSegments, stem];
		if (segments[0] === "vault") return segments.slice(1);
		if (segments[0] === "self") return [...current, ...segments.slice(1)];
		if (segments[0] === "super") {
			let levels = 0;
			while (segments[levels] === "super") levels++;
			if (levels > current.length) return null;
			return [
				...current.slice(0, current.length - levels),
				...segments.slice(levels),
			];
		}
		return [...current, ...segments];
	}

	/**
	 * Mirrors notist's authored target grammar (`ModulePath[/ItemName]`; the
	 * first `/` switches into the flat ItemName space). Resources live in
	 * the target module's directory, and a module path maps 1:1 onto a
	 * vault directory, so resolution is a vault path lookup. Returns null
	 * for non-resource or unresolvable targets.
	 */
	private resolveResourceReference(target: string): TFile | null {
		const body = target.trim();
		const slash = body.indexOf("/");
		if (slash < 0) return null; // bare body is a module path, not a resource
		const name = body.slice(slash + 1).trim();
		const segments = this.resolveModuleSegments(body.slice(0, slash).trim());
		if (!name || !segments) return null;
		const dirPath = segments.filter(Boolean).join("/");
		const path = dirPath ? `${dirPath}/${name}` : name;
		const found = this.app.vault.getAbstractFileByPath(path);
		return found instanceof TFile ? found : null;
	}

	/** Route paste through the same extension event used by Markdown views, then
	 * use Obsidian's attachment path/link APIs for unhandled clipboard images.
	 * Unhandled plain text falls through to CodeMirror. */
	private handlePaste(event: ClipboardEvent): boolean {
		const editor = this.editorAdapter;
		if (!editor) return false;
		const info: MarkdownFileInfo = {
			app: this.app,
			file: this.file,
			editor,
			hoverPopover: null,
		};
		this.app.workspace.trigger("editor-paste", event, editor, info);
		if (event.defaultPrevented) return true;

		const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
			file.type.startsWith("image/"),
		);
		if (images.length === 0) return false;

		event.preventDefault();
		void this.insertClipboardImages(images, editor);
		return true;
	}

	private async insertClipboardImages(
		images: File[],
		editor: NotistEditorAdapter,
	): Promise<void> {
		const sourcePath = this.file?.path ?? "";
		const links: string[] = [];
		for (const image of images) {
			try {
				const filename = `Pasted image ${moment().format("YYYYMMDDHHmmss")}.${this.imageExtension(image)}`;
				const path = await this.app.fileManager.getAvailablePathForAttachment(
					filename,
					sourcePath,
				);
				const attachment = await this.app.vault.createBinary(
					path,
					await image.arrayBuffer(),
				);
				links.push(
					`!${this.app.fileManager.generateMarkdownLink(attachment, sourcePath)}`,
				);
			} catch (error) {
				console.error("Notist: failed to paste clipboard image", error);
				new Notice("Notist: failed to save pasted image");
			}
		}
		if (links.length > 0) editor.replaceSelection(links.join("\n"));
	}

	private imageExtension(image: File): string {
		const fromName = image.name.match(/\.([a-zA-Z0-9]+)$/)?.[1];
		if (fromName) return fromName.toLowerCase();
		const subtype = image.type.slice("image/".length).split("+")[0];
		return subtype === "jpeg" ? "jpg" : subtype || "png";
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

	hasEditor(): boolean {
		return this.editorView !== null;
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
		// File content arrives here after open; safe point to register the
		// document with the LSP session (no-op when already registered).
		this.plugin.lspViewSync(this);
	}

	/** Hot-swap the LSP extension (called when the server starts/stops). */
	setLspExtension(extension: Extension): void {
		this.editorView?.dispatch({
			effects: this.lspCompartment.reconfigure(extension),
		});
	}

	/** Push server diagnostics into the CM lint state. */
	applyLspDiagnostics(diagnostics: LspDiagnostic[]): void {
		if (this.editorView) applyLspDiagnostics(this.editorView, diagnostics);
	}

	/** Reveal a definition target range in this editor. */
	revealLspRange(range: LspRange): void {
		const view = this.editorView;
		if (!view) return;
		const from = offsetFromPos(view.state.doc, range.start);
		const to = offsetFromPos(view.state.doc, range.end);
		view.dispatch({
			selection: { anchor: from, head: to },
			effects: EditorView.scrollIntoView(from, { y: "center" }),
		});
		view.focus();
	}

	clear(): void {
		this.setViewData("", true);
	}
}
