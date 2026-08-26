import { FileSystemAdapter, Menu, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type { Extension } from "@codemirror/state";
import { NotistTextView, VIEW_TYPE_NOTIST } from "./notist-view";
import {
	NotistExplorerView,
	VIEW_TYPE_NOTIST_EXPLORER,
} from "./explorer-view";
import { NotistSettingTab } from "./settings";
import { deinitNotistHighlight, initNotistHighlight } from "./highlight";
import { NotistLspSession, lspUriToPath, type LspState } from "./lsp/session";
import { notistLsp } from "./lsp/cm";
import type { LspDiagnostic, LspLocation } from "./lsp/protocol";

type World = "md" | "notist";

interface NotistPluginData {
	world: World;
	/** aria-labels of ribbon icons that stay visible in the Notist world. */
	ribbonKeep: string[];
	/** Per-world workspace layout snapshots (same format as the Workspaces core plugin). */
	layouts: Partial<Record<World, unknown>>;
	/** Vim keybindings in the .not editor. */
	vimMode: boolean;
	/** Spawn `notist lsp` for semantics (desktop only, opt-in). */
	lspEnabled: boolean;
	/** Command or absolute path of the notist binary. */
	lspBinaryPath: string;
	/** Full argv after the binary (Zed-style整体替换), must include `lsp`. */
	lspBinaryArgs: string[];
}

const TOGGLE_RIBBON_LABEL = "Toggle world (Markdown / Notist)";

const DEFAULT_DATA: NotistPluginData = {
	world: "md",
	ribbonKeep: [TOGGLE_RIBBON_LABEL],
	layouts: {},
	vimMode: false,
	lspEnabled: false,
	lspBinaryPath: "notist",
	lspBinaryArgs: ["lsp"],
};

const LSP_MAX_RESTARTS = 3;

export default class NotistPlugin extends Plugin {
	data: NotistPluginData = DEFAULT_DATA;
	private statusBarEl: HTMLElement | null = null;
	private ribbonObserver: MutationObserver | null = null;
	private switching = false;
	private layoutSaveTimer: number | null = null;
	private lspSession: NotistLspSession | null = null;
	private lspStatusEl: HTMLElement | null = null;
	/** Last session state, kept after the session ref is gone (error/off). */
	private lspLastState: LspState = "off";
	/** Latest per-path diagnostics mirror (paths are absolute). */
	private lspDiags = new Map<string, LspDiagnostic[]>();
	private lspRestartAttempts = 0;
	private lspRestartTimer: number | null = null;
	/** Guards against overlapping startLsp calls (restartLsp is not atomic). */
	private lspStarting = false;
	/** Custom hover tooltip for the LSP status item (Obsidian 1.13's
	 * aria-label tooltips don't fire on status bar items). */
	private lspTooltipEl: HTMLElement | null = null;
	private lspTooltipTimer: number | null = null;
	private lspTooltipText = "";
	private vaultBasePath: string | null = null;
	/** Set in onunload: blocks the async restart path after unload. */
	private unloaded = false;

	async onload(): Promise<void> {
		await this.loadPluginData();
		// Highlight assets load before view registration so a failure cleanly
		// means "no highlighting" — no half-initialized intermediate state.
		await this.initHighlight();
		// LSP is opt-in and best-effort: failure degrades to highlighting only.
		if (this.data.lspEnabled) void this.startLsp();

		this.registerView(VIEW_TYPE_NOTIST, (leaf) => new NotistTextView(leaf, this));
		this.registerView(
			VIEW_TYPE_NOTIST_EXPLORER,
			(leaf) => new NotistExplorerView(leaf),
		);
		this.registerExtensions(["not"], VIEW_TYPE_NOTIST);

		const ribbonEl = this.addRibbonIcon("orbit", TOGGLE_RIBBON_LABEL, () => {
			void this.toggleWorld();
		});
		ribbonEl.addClass("notist-ribbon-keep");

		this.addCommand({
			id: "toggle-world",
			name: "Toggle world (Markdown / Notist)",
			callback: () => void this.toggleWorld(),
		});
		this.addCommand({
			id: "open-notist-explorer",
			name: "Open Notist explorer (experimental module tree placeholder)",
			callback: () => void this.activateExplorer(),
		});
		this.addCommand({
			id: "reset-world-layouts",
			name: "Reset world layouts (clears both snapshots)",
			callback: () => {
				this.data.layouts = {};
				void this.savePluginData().then(
					() => new Notice("Notist: world layouts reset"),
				);
			},
		});

		this.addSettingTab(new NotistSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addEventListener("click", () => void this.toggleWorld());
		this.setupLspStatusItem();

		// Ribbon icons of other plugins may appear after we load; keep the
		// keep-list tagging in sync with ribbon DOM changes.
		this.app.workspace.onLayoutReady(() => {
			this.tagRibbon();
			// Guardrail: foreign leaves must never linger in the current
			// world, including on app start / plugin reload.
			this.purgeForeignLeaves(this.world);
			const ribbon = document.querySelector(".workspace-ribbon");
			if (ribbon) {
				this.ribbonObserver = new MutationObserver(() => this.tagRibbon());
				this.ribbonObserver.observe(ribbon, {
					childList: true,
					subtree: true,
				});
			}
		});
		this.register(() => this.ribbonObserver?.disconnect());

		// Keep the current world's layout snapshot fresh so it survives a
		// crash/kill between world switches.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleLayoutSave()),
		);

		// In the Notist world the native explorer is reused (CSS-filtered to
		// .not files), but "New note" still creates .md. Every creation entry
		// point (header button, context menu, command palette, hotkey) funnels
		// into FileManager.createNewMarkdownFile — patch that single chokepoint
		// to create .not files instead. The explorer's native afterCreate
		// (open + inline rename) then handles the rest.
		this.patchNewFileCreation();

		// Keep the LSP document registry in sync with renames/deletes that
		// happen outside the editor (explorer, sync, git, ...).
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.lspSession || !oldPath.endsWith(".not")) return;
				const text = this.notistViewText(file.path);
				if (text !== null) {
					this.lspSession.fileRenamed(
						this.lspAbsPath(oldPath),
						this.lspAbsPath(file.path),
						text,
					);
				}
				// Views re-register lazily via lspViewSync on next setViewData;
				// update the path key on already-registered views directly.
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
					const view = leaf.view;
					if (view instanceof NotistTextView && view.lspPath === oldPath) {
						view.lspPath = file.path;
					}
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.lspSession || !file.path.endsWith(".not")) return;
				this.lspSession.fileClosed(this.lspAbsPath(file.path));
				this.lspDiags.delete(this.lspAbsPath(file.path));
			}),
		);

		this.applyWorld();
	}

	onunload(): void {
		this.unloaded = true;
		void this.saveCurrentLayout();
		this.hideLspTooltip();
		void this.stopLsp();
		deinitNotistHighlight();
		document.body.classList.remove("notist-world", "md-world");
	}

	/** Load the wasm assets and start tree-sitter highlighting (best-effort). */
	private async initHighlight(): Promise<void> {
		try {
			const dir = this.manifest.dir;
			const adapter = this.app.vault.adapter;
			const [runtime, grammar, querySource] = await Promise.all([
				adapter.readBinary(`${dir}/assets/tree-sitter.wasm`),
				adapter.readBinary(`${dir}/assets/notist.wasm`),
				adapter.read(`${dir}/assets/highlights.scm`),
			]);
			await initNotistHighlight({ runtime, grammar, querySource });
		} catch (e) {
			console.error("Notist: syntax highlighting disabled (init failed)", e);
			new Notice("Notist: syntax highlighting disabled (wasm failed to load)");
		}
	}

	// ---- LSP ----------------------------------------------------------------

	lspAbsPath(vaultRelativePath: string): string {
		return `${this.vaultBasePath ?? ""}/${vaultRelativePath}`;
	}

	/** Current text of an open .not view for `path`, null when not open. */
	private notistViewText(path: string): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
			const view = leaf.view;
			if (view instanceof NotistTextView && view.file?.path === path) {
				return view.getViewData();
			}
		}
		return null;
	}

	/** CM extension for one .not view; [] while LSP is off or down. */
	lspExtension(view: NotistTextView): Extension {
		if (!this.data.lspEnabled) return [];
		return notistLsp({
			session: () => this.lspSession,
			path: () => (view.lspPath ? this.lspAbsPath(view.lspPath) : null),
			openLocation: (loc) => void this.openLspLocation(loc),
		});
	}

	/** Register a view with the session once its file content is in. */
	lspViewSync(view: NotistTextView): void {
		const session = this.lspSession;
		if (!session || session.state !== "ready" || !view.file) return;
		const path = view.file.path;
		if (view.lspPath === path) {
			// Already registered: this setViewData is a save echo or an
			// external edit; the session tells them apart by content.
			if (view.hasEditor()) {
				session.externalChange(this.lspAbsPath(path), view.getViewData());
			}
			return;
		}
		if (view.lspPath) session.viewClosed(this.lspAbsPath(view.lspPath));
		view.lspPath = path;
		session.viewOpened(this.lspAbsPath(path), view.getViewData());
		const diags = this.lspDiags.get(this.lspAbsPath(path));
		if (diags) view.applyLspDiagnostics(diags);
	}

	lspViewClosed(view: NotistTextView): void {
		if (view.lspPath && this.lspSession) {
			this.lspSession.viewClosed(this.lspAbsPath(view.lspPath));
		}
		view.lspPath = null;
	}

	lspDocChanged(view: NotistTextView): void {
		if (this.lspSession && view.lspPath) {
			this.lspSession.docChanged(this.lspAbsPath(view.lspPath), view.getViewData());
		}
	}

	private async startLsp(): Promise<void> {
		if (this.lspSession || this.lspStarting) return;
		this.lspStarting = true;
		try {
			await this.startLspInner();
		} finally {
			this.lspStarting = false;
		}
	}

	private async startLspInner(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("Notist: language server is desktop-only");
			return;
		}
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("Notist: language server needs a filesystem vault");
			return;
		}
		this.vaultBasePath = adapter.getBasePath();
		const session = new NotistLspSession(
			this.data.lspBinaryPath,
			this.data.lspBinaryArgs.length ? this.data.lspBinaryArgs : ["lsp"],
			this.vaultBasePath,
			{
				onDiagnostics: (path, diags) => this.onLspDiagnostics(path, diags),
				onState: (state, detail) => this.onLspState(state, detail),
				onStderr: (text) => console.debug("notist lsp:", text.trimEnd()),
				onLog: (type, message) => {
					// Server-side protocol rejections (e.g. malformed didChange)
					// arrive here since 2026-08-26; make them visible.
					if (type <= 1) console.error("notist lsp:", message);
					else if (type === 2) console.warn("notist lsp:", message);
					else console.debug("notist lsp:", message);
				},
			},
		);
		this.lspSession = session;
		try {
			await session.start();
		} catch (e) {
			console.error("Notist: LSP start failed", e);
		}
	}

	private async stopLsp(): Promise<void> {
		if (this.lspRestartTimer !== null) {
			window.clearTimeout(this.lspRestartTimer);
			this.lspRestartTimer = null;
		}
		const session = this.lspSession;
		this.lspSession = null;
		this.lspDiags.clear();
		this.lspRestartAttempts = 0;
		if (session) await session.stop();
		this.lspLastState = "off";
		this.updateLspStatus();
		// Strip LSP extensions from all open .not editors.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
			const view = leaf.view;
			if (view instanceof NotistTextView) {
				view.setLspExtension([]);
				view.applyLspDiagnostics([]);
			}
		}
	}

	/** Persistent status-bar item (Zed-style): hover shows state/command,
	 * click opens a menu with server actions. */
	private setupLspStatusItem(): void {
		// Drop strays left behind by a previous instance whose async stopLsp
		// outlived plugin reload.
		document
			.querySelectorAll(".notist-lsp-status")
			.forEach((el) => el.remove());
		this.lspStatusEl = this.addStatusBarItem();
		this.lspStatusEl.addClass("notist-lsp-status");
		this.lspStatusEl.addEventListener("click", (evt) => this.showLspMenu(evt));
		this.lspStatusEl.addEventListener("mouseenter", () => {
			if (this.lspTooltipTimer !== null)
				window.clearTimeout(this.lspTooltipTimer);
			this.lspTooltipTimer = window.setTimeout(() => {
				this.lspTooltipTimer = null;
				this.showLspTooltip();
			}, 250);
		});
		this.lspStatusEl.addEventListener("mouseleave", () =>
			this.hideLspTooltip(),
		);
		this.updateLspStatus();
	}

	private updateLspStatus(detail?: string): void {
		if (!this.lspStatusEl) return;
		const state = this.lspSession?.state ?? this.lspLastState;
		const label =
			state === "starting" ? "Notist LSP: starting…" : `Notist LSP: ${state}`;
		this.lspStatusEl.setText(label);
		const lines = [
			`State: ${state}`,
			`Command: ${this.data.lspBinaryPath} ${this.data.lspBinaryArgs.join(" ")}`,
			`Working directory: ${this.vaultBasePath ?? "vault root"}`,
		];
		if (detail) lines.push(detail);
		this.lspTooltipText = lines.join("\n");
		if (this.lspTooltipEl) this.renderLspTooltip();
	}

	private showLspTooltip(): void {
		if (this.lspTooltipEl || !this.lspStatusEl) return;
		this.lspTooltipEl = document.body.createDiv("notist-lsp-tooltip");
		this.renderLspTooltip();
	}

	private renderLspTooltip(): void {
		const tip = this.lspTooltipEl;
		if (!tip || !this.lspStatusEl) return;
		tip.empty();
		for (const line of this.lspTooltipText.split("\n")) {
			tip.createDiv().setText(line);
		}
		// Anchor above the status bar item, right edges aligned.
		const r = this.lspStatusEl.getBoundingClientRect();
		tip.style.right = `${window.innerWidth - r.right}px`;
		tip.style.bottom = `${window.innerHeight - r.top + 6}px`;
	}

	private hideLspTooltip(): void {
		if (this.lspTooltipTimer !== null) {
			window.clearTimeout(this.lspTooltipTimer);
			this.lspTooltipTimer = null;
		}
		this.lspTooltipEl?.remove();
		this.lspTooltipEl = null;
	}

	private showLspMenu(evt: MouseEvent): void {
		this.hideLspTooltip();
		const menu = new Menu();
		const running = this.lspSession !== null;
		if (running) {
			menu.addItem((item) =>
				item
					.setTitle("Restart server")
					.setIcon("rotate-cw")
					.onClick(() => void this.restartLsp()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Stop server")
					.setIcon("power")
					.onClick(() => void this.setLspEnabled(false)),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Start server")
					.setIcon("play")
					.onClick(() => void this.setLspEnabled(true)),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Show recent stderr")
				.setIcon("terminal")
				.onClick(() => {
					const tail = this.lspSession?.getStderrTail().trim();
					new Notice(tail ? tail.split("\n").slice(-8).join("\n") : "Notist LSP: stderr is empty", 10000);
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Plugin settings")
				.setIcon("settings")
				.onClick(() => {
					// Internal API (undocumented but widely used by plugins).
					const setting = (
						this.app as unknown as {
							setting?: { open(): void; openTabById(id: string): void };
						}
					).setting;
					setting?.open();
					setting?.openTabById(this.manifest.id);
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	private onLspState(state: LspState, detail?: string): void {
		if (this.unloaded) return;
		this.lspLastState = state;
		this.updateLspStatus(detail);
		if (state === "ready") {
			this.lspRestartAttempts = 0;
			// Session came up (possibly after views opened): register all
			// open .not views and mount the CM extensions.
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
				const view = leaf.view;
				if (view instanceof NotistTextView) {
					view.setLspExtension(this.lspExtension(view));
					this.lspViewSync(view);
				}
			}
		} else if (state === "error") {
			console.error("Notist: LSP error", detail ?? "");
			this.lspSession = null;
			if (this.data.lspEnabled && this.lspRestartAttempts < LSP_MAX_RESTARTS) {
				const delay = 1000 * 2 ** this.lspRestartAttempts;
				this.lspRestartAttempts++;
				this.lspRestartTimer = window.setTimeout(() => {
					this.lspRestartTimer = null;
					void this.startLsp();
				}, delay);
			} else if (this.data.lspEnabled) {
				const lastLine = detail?.trim().split("\n").pop();
				new Notice(
					`Notist: language server stopped${lastLine ? `: ${lastLine}` : " (see console)"}`,
					10000,
				);
			}
		}
	}

	private onLspDiagnostics(path: string, diags: LspDiagnostic[]): void {
		this.lspDiags.set(path, diags);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
			const view = leaf.view;
			if (
				view instanceof NotistTextView &&
				view.lspPath &&
				this.lspAbsPath(view.lspPath) === path
			) {
				view.applyLspDiagnostics(diags);
			}
		}
	}

	private async openLspLocation(loc: LspLocation): Promise<void> {
		const base = this.vaultBasePath;
		if (!base) return;
		let abs: string;
		try {
			abs = lspUriToPath(loc.uri);
		} catch {
			return;
		}
		if (!abs.startsWith(`${base}/`)) {
			new Notice("Notist: definition target is outside this vault");
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(abs.slice(base.length + 1));
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		if (leaf.view instanceof NotistTextView) {
			leaf.view.revealLspRange(loc.range);
		}
	}

	async setLspEnabled(enabled: boolean): Promise<void> {
		this.data.lspEnabled = enabled;
		await this.savePluginData();
		if (enabled) {
			void this.startLsp();
		} else {
			void this.stopLsp();
		}
	}

	async setLspBinaryPath(path: string): Promise<void> {
		this.data.lspBinaryPath = path;
		await this.savePluginData();
		await this.restartLsp();
	}

	async setLspBinaryArgs(args: string[]): Promise<void> {
		this.data.lspBinaryArgs = args;
		await this.savePluginData();
		await this.restartLsp();
	}

	/** Restart the server after settings changes. Works from any state —
	 * including post-error, where the session reference is already null but
	 * the feature is still enabled (and the backoff restart may have given
	 * up, so we also reset the attempt counter). */
	private async restartLsp(): Promise<void> {
		if (!this.data.lspEnabled) return;
		if (this.lspRestartTimer !== null) {
			window.clearTimeout(this.lspRestartTimer);
			this.lspRestartTimer = null;
		}
		this.lspRestartAttempts = 0;
		if (this.lspSession) await this.stopLsp();
		await this.startLsp();
	}

	get world(): World {
		return this.data.world;
	}

	async savePluginData(): Promise<void> {
		await this.saveData(this.data);
	}

	/** Persist the vim-mode flag and reconfigure every open .not editor. */
	async setVimMode(enabled: boolean): Promise<void> {
		this.data.vimMode = enabled;
		await this.savePluginData();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
			if (leaf.view instanceof NotistTextView) leaf.view.setVimMode(enabled);
		}
	}

	/** Tag allowlisted ribbon icons with .notist-ribbon-keep; CSS hides the rest in Notist world. */
	tagRibbon(): void {
		const keep = new Set(this.data.ribbonKeep);
		document
			.querySelectorAll<HTMLElement>(".side-dock-ribbon-action")
			.forEach((el) => {
				const label = el.getAttribute("aria-label") ?? "";
				el.classList.toggle("notist-ribbon-keep", keep.has(label));
			});
	}

	private async toggleWorld(): Promise<void> {
		const from = this.world;
		const to: World = from === "md" ? "notist" : "md";
		this.switching = true;
		try {
			// Clean the outgoing world before snapshotting so foreign tabs
			// never leak into its stored layout.
			this.purgeForeignLeaves(from);
			this.data.layouts[from] = this.app.workspace.getLayout();
			this.data.world = to;
			this.applyWorld();
			const layout = this.data.layouts[to];
			if (layout) {
				await this.app.workspace.changeLayout(layout);
			}
			// First entry into the Notist world just starts from the current
			// layout: the native file explorer carries over and is reused
			// (CSS-filtered to .not files).
			// Clean again after restore: snapshots saved by earlier versions
			// may contain foreign leaves, this heals them.
			this.purgeForeignLeaves(to);
			this.data.layouts[to] = this.app.workspace.getLayout();
			await this.savePluginData();
		} finally {
			this.switching = false;
		}
	}

	/**
	 * Close tabs that belong to the other world.
	 * md world: no notist views. notist world: no markdown tabs. The native
	 * file explorer is shared by both worlds (CSS-filtered per world).
	 * (Transient cross-world viewing is still possible; it just never
	 * survives a world switch.)
	 */
	private purgeForeignLeaves(world: World): void {
		const foreignTypes =
			world === "md"
				? [VIEW_TYPE_NOTIST, VIEW_TYPE_NOTIST_EXPLORER]
				: ["markdown"];
		for (const type of foreignTypes) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				leaf.detach();
			}
		}
	}

	/**
	 * Patch FileManager.createNewMarkdownFile — the single chokepoint every
	 * "new note" entry point (header button, context menu, command, hotkey)
	 * funnels into. In the Notist world it creates a .not file instead; the
	 * explorer's native afterCreate (open + inline rename) does the rest.
	 * Internal API, restored on unload.
	 */
	private patchNewFileCreation(): void {
		const fm = this.app.fileManager as unknown as {
			createNewMarkdownFile?: (parent: TFolder) => Promise<TFile>;
		};
		if (typeof fm.createNewMarkdownFile !== "function") return;
		const original = fm.createNewMarkdownFile;
		const self = this;
		fm.createNewMarkdownFile = function (parent: TFolder): Promise<TFile> {
			if (self.world === "notist" && !self.switching) {
				return self.createNotFile(parent);
			}
			return original.call(this, parent);
		};
		this.register(() => {
			delete (this.app.fileManager as unknown as Record<string, unknown>)[
				"createNewMarkdownFile"
			];
		});
	}

	/** Create `Untitled.not` (auto-numbered) under `parent` (root if none). */
	private async createNotFile(parent?: TFolder): Promise<TFile> {
		const dir = parent && parent.path !== "/" ? `${parent.path}/` : "";
		let candidate = `${dir}Untitled.not`;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${dir}Untitled ${i++}.not`;
		}
		return this.app.vault.create(candidate, "");
	}

	private scheduleLayoutSave(): void {
		if (this.switching) return;
		if (this.layoutSaveTimer !== null) window.clearTimeout(this.layoutSaveTimer);
		this.layoutSaveTimer = window.setTimeout(() => {
			this.layoutSaveTimer = null;
			void this.saveCurrentLayout();
		}, 500);
	}

	private async saveCurrentLayout(): Promise<void> {
		this.data.layouts[this.world] = this.app.workspace.getLayout();
		await this.savePluginData();
	}

	private applyWorld(): void {
		document.body.classList.toggle("notist-world", this.world === "notist");
		document.body.classList.toggle("md-world", this.world === "md");
		this.statusBarEl?.setText(
			this.world === "notist" ? "World: Notist" : "World: Markdown",
		);
	}

	private async activateExplorer(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_NOTIST_EXPLORER)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({
				type: VIEW_TYPE_NOTIST_EXPLORER,
				active: true,
			});
		}
		workspace.revealLeaf(leaf);
	}

	private async loadPluginData(): Promise<void> {
		this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
	}
}
