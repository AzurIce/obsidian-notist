import {
	HoverParent,
	HoverPopover,
	Notice,
	TFile,
	TextFileView,
	WorkspaceLeaf,
	moment,
	setIcon,
	type ViewStateResult,
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
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import { getCM, vim } from "@replit/codemirror-vim";
import { notistHighlight } from "./highlight";
import { notistImageHover, isImageExtension, type ImageRefHover } from "./image-hover";
import { notistRefJump } from "./ref-jump";
import { notistMultiCursor } from "./multi-cursor";
import { SourceMap } from "./lsp/source-map";
import {
	applyLspDiagnostics,
	offsetFromPos,
	posFromOffset,
} from "./lsp/cm";
import type { LspDiagnostic, LspRange, LspRenderDocumentResult, LspRenderedResource } from "./lsp/protocol";
import type NotistPlugin from "./main";
import { NotistEditorAdapter } from "./editor-adapter";
import {
	composePreviewDocument,
	needsPluginAssets,
	rewritePreviewLinks,
	type SiteAssets,
} from "./preview";

export const VIEW_TYPE_NOTIST = "notist-view";

/** Editor view modes, mirroring MarkdownViewModeType: rendered document vs
 * source editor inside the same view (mode persists in the leaf state). */
export type NotistViewMode = "source" | "preview";

/** Trailing debounce for preview re-renders while typing in source mode. */
const PREVIEW_DEBOUNCE_MS = 500;

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
	/** Current view mode; persisted in the leaf state (getState/setState). */
	private mode: NotistViewMode = "source";
	private previewEl: HTMLElement | null = null;
	private previewFrame: HTMLIFrameElement | null = null;
	private previewNoticeEl: HTMLElement | null = null;
	private previewActionEl: HTMLElement | null = null;
	private previewRenderTimer: number | null = null;
	/** Guards superseded renders (mode switches, newer revisions). */
	private previewRenderSeq = 0;
	/** Revision already on screen; skips redundant re-renders. */
	private previewRevision: number | null = null;
	/** Whether the live iframe shell was composed with web-component scripts. */
	private previewComponentsLoaded = false;
	/** Suppression for requestSave/LSP forwarding while setViewData replaces the doc. */
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
		// New tabs open in the configured default mode; a persisted leaf
		// state (setState) wins over this once the layout restores.
		this.mode = plugin.data.defaultViewMode;
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
		// Preview container (hidden while in source mode); the iframe is
		// created lazily on first render.
		this.previewEl = this.contentEl.createDiv("notist-preview");
		this.previewActionEl = this.addAction(
			this.mode === "source" ? "book-open" : "pencil",
			this.mode === "source"
				? "Show rendered document"
				: "Show source editor",
			() => this.setMode(this.mode === "source" ? "preview" : "source"),
		);
		this.contentEl.toggleClass("notist-mode-preview", this.mode === "preview");
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
					// defaultKeymap deliberately omits Tab; without indentWithTab
					// the browser moves focus out of the editor instead.
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
						// Alt+click/alt+drag to add cursors/selection ranges.
						notistMultiCursor(),
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
							if (this.mode === "preview") this.schedulePreviewRender();
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
		// Keep the preview iframe's theme in step with Obsidian's.
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				const doc = this.previewFrame?.contentDocument;
				if (doc) this.applyPreviewTheme(doc);
			}),
		);
	}

	async onClose(): Promise<void> {
		this.plugin.lspViewClosed(this);
		this.hideImagePopover();
		this.cancelPendingPreviewRender();
		this.previewRenderSeq++; // drop in-flight renders
		this.editorView?.destroy();
		this.editorView = null;
		this.editorAdapter = null;
		this.contentEl.empty();
		this.titleInputEl = null;
		this.previewEl = null;
		this.previewFrame = null;
		this.previewNoticeEl = null;
		this.previewActionEl = null;
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
		// The text tooltip is suppressed for image refs; its information
		// (resolved module/label) becomes the popover caption instead.
		void this.addImagePopoverCaption(popover, hover);
	}

	/** Fetches the LSP hover text for the reference and shows it above the
	 * image (server off: falls back to the resolved vault path). No-op if
	 * the popover was replaced or hidden before the response arrives. */
	private async addImagePopoverCaption(
		popover: HoverPopover,
		hover: ImageRefHover,
	): Promise<void> {
		const doc = this.editorView?.state.doc;
		let text: string | null = null;
		if (doc) {
			const info = await this.plugin.lspHover(
				this,
				posFromOffset(doc, hover.from),
			);
			if (info) {
				text =
					typeof info.contents === "string"
						? info.contents
						: info.contents.value;
			}
		}
		if (!text) {
			text = this.resolveResourceReference(hover.target)?.path ?? hover.target;
		}
		if (this.imagePopover !== popover) return;
		const caption = popover.hoverEl.createDiv("notist-image-hover-caption");
		caption.setText(text);
		const img = popover.hoverEl.querySelector("img.notist-image-hover");
		if (img) popover.hoverEl.insertBefore(caption, img);
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

	// ---- preview mode --------------------------------------------------------
	// Mirrors MarkdownView's source/preview logic: one view, two panes, the
	// active one persisted in the leaf state. The preview pane renders the
	// module's evaluated fragment from notist/renderDocument inside a
	// same-origin iframe; nothing is re-interpreted client-side.

	getMode(): NotistViewMode {
		return this.mode;
	}

	setMode(mode: NotistViewMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.contentEl.toggleClass("notist-mode-preview", mode === "preview");
		this.updatePreviewAction();
		if (mode === "preview") {
			this.schedulePreviewRender();
		} else {
			this.cancelPendingPreviewRender();
			this.previewRenderSeq++; // drop any in-flight render
		}
	}

	/** Force a re-render even if the revision looks unchanged (LSP restart). */
	refreshPreview(): void {
		this.previewRevision = null;
		if (this.mode === "preview") this.schedulePreviewRender();
	}

	private updatePreviewAction(): void {
		const el = this.previewActionEl;
		if (!el) return;
		setIcon(el, this.mode === "source" ? "book-open" : "pencil");
		el.setAttribute(
			"aria-label",
			this.mode === "source" ? "Show rendered document" : "Show source editor",
		);
	}

	/** The mode rides the leaf state (like MarkdownView's `mode`), so it
	 * survives layout saves, world switches and app restarts. */
	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode };
	}

	setState(state: unknown, result: ViewStateResult): Promise<void> {
		const savedMode = (state as { mode?: unknown } | null)?.mode;
		return super.setState(state, result).then(() => {
			if (savedMode === "preview" || savedMode === "source") {
				this.setMode(savedMode);
			}
		});
	}

	private schedulePreviewRender(): void {
		if (this.previewRenderTimer !== null) window.clearTimeout(this.previewRenderTimer);
		this.previewRenderTimer = window.setTimeout(() => {
			this.previewRenderTimer = null;
			void this.renderPreview();
		}, PREVIEW_DEBOUNCE_MS);
	}

	private cancelPendingPreviewRender(): void {
		if (this.previewRenderTimer !== null) {
			window.clearTimeout(this.previewRenderTimer);
			this.previewRenderTimer = null;
		}
	}

	private async renderPreview(): Promise<void> {
		if (!this.previewEl || !this.file) return;
		const token = ++this.previewRenderSeq;
		const session = this.plugin.getLspSession();
		if (!session || !session.supportsRenderDocument()) {
			this.showPreviewNotice(
				session
					? "Notist: the running language server cannot render documents. Update the notist binary and restart the server."
					: "Notist: preview needs the Notist language server. Enable it in the plugin settings.",
			);
			return;
		}
		const result = await session.renderDocument(this.plugin.lspAbsPath(this.file.path));
		// Superseded/cancelled renders return null too, but only a failure on
		// the current render reaches here — show it instead of a blank pane.
		if (token !== this.previewRenderSeq || this.mode !== "preview") return;
		if (!result) {
			this.showPreviewNotice(
				"Notist: rendering failed (the document may not be registered with the language server). Try restarting the server.",
			);
			return;
		}
		if (result.revision === this.previewRevision) return;
		const assets = await this.plugin.getSiteAssets();
		if (!assets) {
			this.showPreviewNotice(
				"Notist: site assets are missing (assets/site). Refresh them with `bun run assets:site`.",
			);
			return;
		}
		if (token !== this.previewRenderSeq || this.mode !== "preview") return;
		this.hidePreviewNotice();
		this.previewRevision = result.revision;
		this.writePreviewFrame(result, assets);
	}

	/** First render composes the full iframe shell; later ones swap the
	 * article content in place so scroll position survives. A fragment that
	 * newly needs web components forces one recomposition (the module
	 * scripts are baked into the shell). */
	private writePreviewFrame(result: LspRenderDocumentResult, assets: SiteAssets): void {
		if (!this.previewEl) return;
		const needsComponents = needsPluginAssets(result);
		const doc = this.previewFrame?.contentDocument ?? null;
		const article = doc?.querySelector("article.notist-document") ?? null;
		if (doc && article && (this.previewComponentsLoaded || !needsComponents)) {
			article.innerHTML = result.page.fragment;
			this.applyPreviewTheme(doc);
			rewritePreviewLinks(
				doc,
				result,
				(resource) => this.previewResourcePath(resource),
				(segments) => segments.filter(Boolean).join("/"),
			);
			return;
		}
		const frame = this.previewEl.createEl("iframe", {
			cls: "notist-preview-frame",
			attr: { title: "Rendered document" },
		});
		this.previewFrame?.remove();
		this.previewFrame = frame;
		this.previewComponentsLoaded = needsComponents;
		frame.srcdoc = composePreviewDocument(
			result,
			assets,
			this.themeClasses(),
			needsComponents,
		);
		frame.addEventListener("load", () => {
			const frameDoc = frame.contentDocument;
			if (!frameDoc) return;
			this.applyPreviewTheme(frameDoc);
			rewritePreviewLinks(
				frameDoc,
				result,
				(resource) => this.previewResourcePath(resource),
				(segments) => segments.filter(Boolean).join("/"),
			);
			frameDoc.addEventListener("click", (event) => this.onPreviewClick(event));
		});
	}

	private applyPreviewTheme(doc: Document): void {
		const theme = document.body.classList.contains("theme-light")
			? "theme-light"
			: "theme-dark";
		doc.documentElement?.classList.toggle("theme-light", theme === "theme-light");
		doc.documentElement?.classList.toggle("theme-dark", theme === "theme-dark");
		doc.body?.classList.toggle("theme-light", theme === "theme-light");
		doc.body?.classList.toggle("theme-dark", theme === "theme-dark");
	}

	/** Module anchors navigate inside Obsidian; in-document anchors and
	 * rewritten resource links keep their default behavior. */
	private onPreviewClick(event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		const anchor = target?.closest?.("a[href]");
		if (!anchor) return;
		const moduleDir = anchor.getAttribute("data-notist-module");
		if (moduleDir === null) return;
		event.preventDefault();
		this.openModuleFallback(moduleDir);
	}

	/** Vault-relative vault path (resource file) for `moduleSegments/name`. */
	private previewResourcePath(resource: LspRenderedResource): string | null {
		const prefix = resource.moduleSegments.filter(Boolean).join("/");
		const path = prefix ? `${prefix}/${resource.name}` : resource.name;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
	}

	private showPreviewNotice(message: string): void {
		if (!this.previewEl) return;
		this.hidePreviewNotice();
		this.previewNoticeEl = this.previewEl.createDiv("notist-preview-notice");
		this.previewNoticeEl.setText(message);
	}

	private hidePreviewNotice(): void {
		this.previewNoticeEl?.remove();
		this.previewNoticeEl = null;
	}

	private themeClasses(): string {
		return document.body.classList.contains("theme-light") ? "theme-light" : "theme-dark";
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
		// External edits (save echoes of the hidden editor, sync, git) must
		// reach the preview too.
		if (this.mode === "preview") this.schedulePreviewRender();
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

	/** Reveal a definition target range in this editor. Wire ranges carry
	 * utf-8 byte columns — convert them against this document's text (the
	 * target was opened above, so the doc matches what the server served). */
	revealLspRange(range: LspRange): void {
		const view = this.editorView;
		if (!view) return;
		const map = SourceMap.fromText(view.state.doc.toString());
		const start = map.position(map.byteAtLine(range.start.line) + range.start.character);
		const end = map.position(map.byteAtLine(range.end.line) + range.end.character);
		const from = offsetFromPos(view.state.doc, start);
		const to = offsetFromPos(view.state.doc, end);
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
