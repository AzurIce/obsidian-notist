import { FileSystemAdapter, Menu, Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { NotistTextView, VIEW_TYPE_NOTIST } from "./notist-view";
import { NotistExplorerView, VIEW_TYPE_NOTIST_EXPLORER } from "./explorer-view";
import {
	NotistBacklinksView,
	NotistOutlineView,
	NotistOutgoingLinksView,
	NotistSymbolModal,
	VIEW_TYPE_NOTIST_BACKLINKS,
	VIEW_TYPE_NOTIST_OUTGOING,
	VIEW_TYPE_NOTIST_OUTLINE,
} from "./semantic-panels";
import { NotistProblemsDock } from "./problems-dock";
import { ExplorerDiagnosticBadges } from "./explorer-badges";
import { NotistSettingTab } from "./settings";
import { deinitNotistHighlight, initNotistHighlight } from "./highlight";
import { NotistLspSession, lspPathToUri, lspUriToPath, type LspState } from "./lsp/session";
import { notistLsp } from "./lsp/cm";
import type { SiteAssets } from "./preview";
import type { LspDiagnostic, LspHover, LspLocation, LspPosition } from "./lsp/protocol";

type World = "md" | "notist";

interface InternalCommand {
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
}

interface NotistPluginData {
	world: World;
	/** aria-labels of ribbon icons that stay visible in the Notist world. */
	ribbonKeep: string[];
	/** Per-world workspace layout snapshots (same format as the Workspaces core plugin). */
	layouts: Partial<Record<World, unknown>>;
	/** Vim keybindings in the .not editor. */
	vimMode: boolean;
	/** Default mode when a .not file opens in a new tab (mirrors the
	 * Markdown world's "Default view for new tabs"). */
	defaultViewMode: "source" | "preview";
	/** Spawn `notist lsp` for semantics (desktop only, opt-in). */
	lspEnabled: boolean;
	/** How to invoke the notist CLI; the plugin appends subcommands
	 * (`lsp` today, `build` etc. later) and spawns the result. */
	notistCommand: string;
	/** Extra flags appended after the subcommand (e.g. `--no-daemon`
	 * to embed the service in the server process). */
	notistExtraArgs: string;
	/** Problems dock expanded across reloads (user preference). */
	problemsExpanded: boolean;
}

export interface LspDiagnosticCounts {
	errors: number;
	warnings: number;
	info: number;
	hints: number;
	total: number;
}

const TOGGLE_RIBBON_LABEL = "Toggle world (Markdown / Notist)";
const LEGACY_VIEW_TYPES = ["notist-diagnostics"];

const DEFAULT_DATA: NotistPluginData = {
	world: "md",
	ribbonKeep: [TOGGLE_RIBBON_LABEL],
	layouts: {},
	vimMode: false,
	defaultViewMode: "source",
	lspEnabled: false,
	notistCommand: "notist",
	notistExtraArgs: "",
	problemsExpanded: false,
};

const LSP_MAX_RESTARTS = 3;

/** Split a command string into argv on whitespace; "..." and '...' keep
 * spaces inside one argument. Not a shell: ~, $VAR and globs stay literal. */
function tokenizeCommand(input: string): string[] {
	const argv: string[] = [];
	let token = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	for (const ch of input) {
		if (quote) {
			if (ch === quote) quote = null;
			else token += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) {
				argv.push(token);
				token = "";
				started = false;
			}
		} else {
			token += ch;
			started = true;
		}
	}
	if (started) argv.push(token);
	return argv;
}

/** Inverse of tokenizeCommand for one argv element (data migration only). */
function quoteArg(arg: string): string {
	if (!/\s/.test(arg)) return arg;
	return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/** Wrapper launchers whose trailing arguments only reach the wrapped
 * program after a `--`. `notist` itself rejects `-- lsp`, so the
 * separator is inserted only when the command starts with one of these
 * and contains no `--` yet. */
const WRAPPER_LAUNCHERS = new Set([
	"nix",
	"nix-shell",
	"cargo",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"mise",
	"devbox",
	"devenv",
	"asdf",
]);

const NOTIST_FOREIGN_VIEW_TYPES = [
	"backlink",
	"outgoing-link",
	"outline",
	"graph",
	"localgraph",
	"tag",
	"tag-explorer",
	"all-properties",
	"file-properties",
	"excalidraw-sidepanel",
];

export default class NotistPlugin extends Plugin {
	data: NotistPluginData = DEFAULT_DATA;
	private statusBarEl: HTMLElement | null = null;
	private ribbonObserver: MutationObserver | null = null;
	private switching = false;
	private layoutSaveTimer: number | null = null;
	/** Serialize whole-object data.json writes so an older layout save cannot
	 * finish after a newer world/settings save and overwrite it. */
	private dataSaveQueue: Promise<void> = Promise.resolve();
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
	/** Vendored preview site assets; undefined = not loaded yet. */
	private siteAssetsCache: SiteAssets | null | undefined;
	private problemsDock: NotistProblemsDock | null = null;
	private explorerBadges: ExplorerDiagnosticBadges | null = null;
	/** Outline-style consumers of caret movement inside .not editors. */
	private readonly cursorListeners = new Set<
		(cursor: { path: string; line: number }) => void
	>();
	private lastCursor: { path: string; line: number } | null = null;
	/** Set in onunload: blocks the async restart path after unload. */
	private unloaded = false;
	private lastNotistPath: string | null = null;

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
			(leaf) => new NotistExplorerView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_NOTIST_OUTLINE,
			(leaf) => new NotistOutlineView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_NOTIST_BACKLINKS,
			(leaf) => new NotistBacklinksView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_NOTIST_OUTGOING,
			(leaf) => new NotistOutgoingLinksView(leaf, this),
		);
		this.registerExtensions(["not"], VIEW_TYPE_NOTIST);
		this.problemsDock = new NotistProblemsDock(
			this,
			this.app.workspace.containerEl,
		);
		this.explorerBadges = new ExplorerDiagnosticBadges(this);

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
			id: "toggle-notist-problems",
			name: "Toggle Notist Problems",
			callback: () => this.problemsDock?.toggle(),
		});
		this.addCommand({
			id: "toggle-notist-preview",
			name: "Toggle Notist preview",
			checkCallback: (checking) => {
				const view = this.app.workspace.activeLeaf?.view;
				if (!(view instanceof NotistTextView)) return false;
				if (!checking) {
					view.setMode(view.getMode() === "source" ? "preview" : "source");
				}
				return true;
			},
		});
		this.addCommand({
			id: "open-notist-explorer",
			name: "Open Notist explorer",
			callback: () => void this.activateExplorer(),
		});
		this.addCommand({
			id: "open-notist-outline",
			name: "Open Notist outline",
			callback: () => void this.activateSemanticView(VIEW_TYPE_NOTIST_OUTLINE),
		});
		this.addCommand({
			id: "open-notist-backlinks",
			name: "Open Notist backlinks",
			callback: () => void this.activateSemanticView(VIEW_TYPE_NOTIST_BACKLINKS),
		});
		this.addCommand({
			id: "open-notist-outgoing",
			name: "Open Notist outgoing links",
			callback: () => void this.activateSemanticView(VIEW_TYPE_NOTIST_OUTGOING),
		});
		this.addCommand({
			id: "open-notist-symbols",
			name: "Open Notist symbol search",
			callback: () => this.openNotistSymbols(),
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
			this.purgeLegacyLeaves();
			// File explorer exists by now; start decorating it with badges.
			this.explorerBadges?.sync();
			// Guardrail: foreign leaves must never linger in the current
			// world, including on app start / plugin reload.
			this.purgeForeignLeaves(this.world);
			// The explorer is the Notist world's default sidebar tab.
			if (this.world === "notist") void this.ensureExplorer();
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
			this.app.workspace.on("layout-change", () => {
				if (!this.switching && this.world === "notist") {
					this.purgeForeignLeaves(this.world);
				}
				// changeLayout replaces .workspace-split.mod-root; re-mount the
				// dock (and re-bind explorer badges) onto the new DOM subtree.
				if (this.problemsDock && !this.problemsDock.isMounted()) {
					this.problemsDock.mount(this.app.workspace.containerEl);
				}
				this.explorerBadges?.sync();
				this.scheduleLayoutSave();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof NotistTextView && leaf.view.file) {
					this.lastNotistPath = leaf.view.file.path;
				}
				if (this.world === "notist") this.purgeForeignLeaves(this.world);
			}),
		);
		this.patchQuickSwitcher();
		this.patchCommandPalette();

		// In the Notist world the native explorer is reused (CSS-filtered to
		// hide Markdown while keeping .not and resource files), but "New note"
		// still creates .md. Every creation entry
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
				const oldAbsPath = this.lspAbsPath(oldPath);
				const newAbsPath = this.lspAbsPath(file.path);
				const renamedDiagnostics = this.lspDiags.get(oldAbsPath);
				if (renamedDiagnostics) {
					this.lspDiags.delete(oldAbsPath);
					this.lspDiags.set(newAbsPath, renamedDiagnostics);
				}
				this.refreshProblemsDock();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.lspSession || !file.path.endsWith(".not")) return;
				this.lspSession.fileClosed(this.lspAbsPath(file.path));
				this.lspDiags.delete(this.lspAbsPath(file.path));
				this.refreshProblemsDock();
				this.updateLspStatus();
			}),
		);

		this.applyWorld();
	}

	onunload(): void {
		this.unloaded = true;
		if (this.layoutSaveTimer !== null) {
			window.clearTimeout(this.layoutSaveTimer);
			this.layoutSaveTimer = null;
		}
		void this.saveCurrentLayout();
		this.hideLspTooltip();
		this.explorerBadges?.unmount();
		this.explorerBadges = null;
		this.problemsDock?.unmount();
		this.problemsDock = null;
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

	/** Vendored site assets for the preview iframe (assets/site/, refreshed
	 * by `bun run assets:site`), loaded lazily and cached per app run. Null
	 * when missing — preview mode then degrades to a notice. */
	async getSiteAssets(): Promise<SiteAssets | null> {
		if (this.siteAssetsCache !== undefined) return this.siteAssetsCache;
		const adapter = this.app.vault.adapter;
		const dir = `${this.manifest.dir}/assets/site`;
		try {
			const styleCss = await adapter.read(`${dir}/style.css`);
			const pluginScripts: { name: string; source: string }[] = [];
			const pluginStyles: { name: string; source: string }[] = [];
			const pluginsRoot = `${dir}/plugins`;
			if (await adapter.exists(pluginsRoot)) {
				const listing = await adapter.list(pluginsRoot);
				for (const folder of listing.folders) {
					for (const file of (await adapter.list(folder)).files) {
						if (file.endsWith(".js")) {
							pluginScripts.push({ name: file, source: await adapter.read(file) });
						} else if (file.endsWith(".css")) {
							pluginStyles.push({ name: file, source: await adapter.read(file) });
						}
					}
				}
			}
			this.siteAssetsCache = { styleCss, pluginScripts, pluginStyles };
		} catch (e) {
			console.error("Notist: preview site assets unavailable", e);
			this.siteAssetsCache = null;
		}
		return this.siteAssetsCache;
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

	/** Definition location for a position in one view's document; null when
	 * the server is off/down or nothing resolves there (callers fall back). */
	async lspDefinition(
		view: NotistTextView,
		position: LspPosition,
	): Promise<LspLocation | null> {
		const session = this.lspSession;
		if (!session || session.state !== "ready" || !view.lspPath) return null;
		return session.definition(this.lspAbsPath(view.lspPath), position);
	}

	/** Hover text for a position in one view's document; null when the
	 * server is off/down. */
	async lspHover(view: NotistTextView, position: LspPosition): Promise<LspHover | null> {
		const session = this.lspSession;
		if (!session || session.state !== "ready" || !view.lspPath) return null;
		return session.hover(this.lspAbsPath(view.lspPath), position);
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
		this.lastNotistPath = path;
		session.viewOpened(this.lspAbsPath(path), view.getViewData());
		const diags = this.lspDiags.get(this.lspAbsPath(path));
		if (diags) view.applyLspDiagnostics(diags);
		this.refreshSemanticViews();
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

	getLspSession(): NotistLspSession | null {
		return this.lspSession;
	}

	activeNotistPath(): string | null {
		const active = this.app.workspace.activeLeaf?.view;
		if (active instanceof NotistTextView && active.file) return this.lspAbsPath(active.file.path);
		return this.lastNotistPath ? this.lspAbsPath(this.lastNotistPath) : null;
	}

	pathToLspUri(path: string): string {
		return lspPathToUri(path);
	}

	locationLabel(location: LspLocation): string {
		try {
			const path = lspUriToPath(location.uri);
			const base = this.vaultBasePath;
			const relative = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
			return `${relative}:${location.range.start.line + 1}`;
		} catch {
			return location.uri;
		}
	}

	/** Absolute vault root, null before an LSP start on a filesystem vault. */
	vaultBaseAbsolutePath(): string | null {
		return this.vaultBasePath;
	}

	/** Vault-relative path for an LSP URI, null when not decodable. */
	relativePathForUri(uri: string): string | null {
		try {
			return this.lspDisplayPath(lspUriToPath(uri));
		} catch {
			return null;
		}
	}

	/** Live editor overlay text for a vault-relative .not path, else null. */
	liveVaultFileText(relativePath: string): string | null {
		return this.notistViewText(relativePath);
	}

	/** Explorer badge click-through: open a file at its first diagnostic. */
	async openVaultRelativeDiagnostic(relativePath: string): Promise<void> {
		const abs = this.lspAbsPath(relativePath);
		const diagnostics = this.lspDiags.get(abs) ?? [];
		if (!diagnostics.length) return;
		await this.openLspDiagnostic(abs, diagnostics[0]);
	}

	// ---- .not editor caret tracking (outline highlight) ---------------------

	registerNotistCursorListener(
		listener: (cursor: { path: string; line: number }) => void,
	): () => void {
		this.cursorListeners.add(listener);
		return () => {
			this.cursorListeners.delete(listener);
		};
	}

	lastNotistCursor(): { path: string; line: number } | null {
		return this.lastCursor;
	}

	/** Fan out caret movement from a .not editor; dedupes repeats so the CM
	 * listener can call it on every transaction without cost concerns. */
	notifyViewCursor(view: NotistTextView, cm: EditorView): void {
		if (!this.cursorListeners.size || !view.file) return;
		const head = cm.state.selection.main.head;
		const cursor = { path: view.file.path, line: cm.state.doc.lineAt(head).number - 1 };
		const prev = this.lastCursor;
		if (prev && prev.path === cursor.path && prev.line === cursor.line) return;
		this.lastCursor = cursor;
		for (const listener of this.cursorListeners) listener(cursor);
	}

	/** Full argv for a notist CLI subcommand — `lsp` today, `build` etc.
	 * later — reusing the user-configured launcher command and extra
	 * flags. */
	private notistArgv(subcommand: string, ...rest: string[]): string[] {
		const base = tokenizeCommand(this.data.notistCommand);
		const needsSeparator =
			!base.includes("--") && WRAPPER_LAUNCHERS.has(base[0] ?? "");
		return [
			...base,
			...(needsSeparator ? ["--"] : []),
			subcommand,
			...tokenizeCommand(this.data.notistExtraArgs),
			...rest,
		];
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
			this.notistArgv("lsp"),
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
		this.refreshProblemsDock();
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
		const counts = this.getLspDiagnosticCounts();
		const label =
			state === "starting" ? "Notist LSP: starting…" : `Notist LSP: ${state}`;
		this.lspStatusEl.setText(
			state === "ready" && (counts.errors > 0 || counts.warnings > 0)
				? `${label} · E ${counts.errors} W ${counts.warnings}`
				: label,
		);
		const lines = [
			`State: ${state}`,
			`Command: ${this.notistArgv("lsp").join(" ")}`,
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
				.setTitle("Toggle Problems")
				.setIcon("list-x")
				.onClick(() => this.problemsDock?.toggle()),
		);
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
					// A (re)started session has an empty doc registry; views
					// opened before the restart still carry lspPath and would
					// be treated as already registered — force re-registration.
					view.lspPath = null;
					view.setLspExtension(this.lspExtension(view));
					this.lspViewSync(view);
					view.refreshPreview();
				}
			}
			this.refreshSemanticViews();
			this.refreshProblemsDock();
			this.updateLspStatus();
		} else if (state === "error") {
			console.error("Notist: LSP error", detail ?? "");
			this.lspSession = null;
			this.lspDiags.clear();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
				const view = leaf.view;
				if (view instanceof NotistTextView) {
					view.setLspExtension([]);
					view.applyLspDiagnostics([]);
					view.refreshPreview();
				}
			}
			this.refreshProblemsDock();
			this.updateLspStatus(detail);
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
		this.refreshSemanticViews();
		this.refreshProblemsDock();
		this.updateLspStatus();
	}

	getLspDisplayState(): LspState {
		return this.lspSession?.state ?? this.lspLastState;
	}

	getLspDiagnosticsSnapshot(): Array<[string, LspDiagnostic[]]> {
		return [...this.lspDiags.entries()].map(([path, diagnostics]) => [
			path,
			[...diagnostics],
		]);
	}

	getLspDiagnosticCounts(): LspDiagnosticCounts {
		const counts = { errors: 0, warnings: 0, info: 0, hints: 0, total: 0 };
		for (const diagnostics of this.lspDiags.values()) {
			for (const diagnostic of diagnostics) {
				counts.total++;
				switch (diagnostic.severity) {
					case 2:
						counts.warnings++;
						break;
					case 3:
						counts.info++;
						break;
					case 4:
						counts.hints++;
						break;
					default:
						counts.errors++;
				}
			}
		}
		return counts;
	}

	getLspDiagnosticCountsForPath(path: string): LspDiagnosticCounts {
		const diagnostics = this.lspDiags.get(this.lspAbsPath(path)) ?? [];
		const counts = { errors: 0, warnings: 0, info: 0, hints: 0, total: diagnostics.length };
		for (const diagnostic of diagnostics) {
			switch (diagnostic.severity) {
				case 2:
					counts.warnings++;
					break;
				case 3:
					counts.info++;
					break;
				case 4:
					counts.hints++;
					break;
				default:
					counts.errors++;
			}
		}
		return counts;
	}

	lspDisplayPath(path: string): string {
		const base = this.vaultBasePath;
		return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
	}

	async openLspDiagnostic(path: string, diagnostic: LspDiagnostic): Promise<void> {
		await this.openLspLocation({ uri: lspPathToUri(path), range: diagnostic.range });
	}

	/** Refresh every vault-level diagnostic surface: the Problems dock, the
	 * file-explorer badges and the Notist explorer tree pills (semantic
	 * panels have their own path). */
	private refreshProblemsDock(): void {
		this.problemsDock?.refresh();
		this.explorerBadges?.refresh();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST_EXPLORER)) {
			const view = leaf.view as { refreshDiagnostics?: () => void };
			view.refreshDiagnostics?.();
		}
	}

	private refreshSemanticViews(): void {
		for (const type of [VIEW_TYPE_NOTIST_OUTLINE, VIEW_TYPE_NOTIST_BACKLINKS, VIEW_TYPE_NOTIST_OUTGOING]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const view = leaf.view as { refresh?: () => void };
				view.refresh?.();
			}
		}
	}

	async openLspLocation(loc: LspLocation): Promise<void> {
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

	async setNotistCommand(command: string): Promise<void> {
		this.data.notistCommand = command;
		await this.savePluginData();
		await this.restartLsp();
	}

	async setNotistExtraArgs(args: string): Promise<void> {
		this.data.notistExtraArgs = args;
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
		const snapshot = JSON.parse(JSON.stringify(this.data)) as NotistPluginData;
		const save = this.dataSaveQueue.then(() => this.saveData(snapshot));
		this.dataSaveQueue = save.catch((error) => {
			console.error("Notist: failed to save plugin data", error);
		});
		await save;
	}

	/** Persist the vim-mode flag and reconfigure every open .not editor. */
	async setVimMode(enabled: boolean): Promise<void> {
		this.data.vimMode = enabled;
		await this.savePluginData();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST)) {
			if (leaf.view instanceof NotistTextView) leaf.view.setVimMode(enabled);
		}
	}

	/** Default mode for .not files opening in a new tab (no live effect on
	 * already-open views — their mode is persisted per leaf, like Markdown). */
	async setDefaultViewMode(mode: "source" | "preview"): Promise<void> {
		this.data.defaultViewMode = mode;
		await this.savePluginData();
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
		if (this.switching) return;
		const from = this.world;
		const to: World = from === "md" ? "notist" : "md";
		this.switching = true;
		if (this.layoutSaveTimer !== null) {
			window.clearTimeout(this.layoutSaveTimer);
			this.layoutSaveTimer = null;
		}
		try {
			// Clean the outgoing world before snapshotting so foreign tabs
			// never leak into its stored layout.
			this.purgeForeignLeaves(from);
			this.data.layouts[from] = this.app.workspace.getLayout();
			this.data.world = to;
			this.applyWorld();
			// Persist the world identity before layout restoration. changeLayout
			// can be interrupted by an app/plugin reload, but the next load must
			// still return to the world the user selected.
			await this.savePluginData();
			const layout = this.data.layouts[to];
			if (layout) {
				await this.app.workspace.changeLayout(layout);
			}
			// First entry into the Notist world just starts from the current
			// layout: the native file explorer carries over and is reused
			// (CSS-filtered to hide Markdown files).
			// Clean again after restore: snapshots saved by earlier versions
			// may contain foreign leaves, this heals them.
			this.purgeForeignLeaves(to);
			// Re-open the default tab before re-snapshotting so the Notist
			// layout keeps it across switches.
			if (to === "notist") await this.ensureExplorer();
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
				? [
					VIEW_TYPE_NOTIST,
					VIEW_TYPE_NOTIST_EXPLORER,
					VIEW_TYPE_NOTIST_OUTLINE,
					VIEW_TYPE_NOTIST_BACKLINKS,
					VIEW_TYPE_NOTIST_OUTGOING,
				]
				: ["markdown", ...NOTIST_FOREIGN_VIEW_TYPES];
		for (const type of foreignTypes) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				leaf.detach();
			}
		}
	}

	private async activateSemanticView(type: string): Promise<void> {
		if (this.world !== "notist") {
			new Notice("Switch to Notist World first");
			return;
		}
		let leaf = this.app.workspace.getLeavesOfType(type)[0] ?? null;
		if (!leaf) {
			const rightLeaf = this.app.workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await rightLeaf.setViewState({ type, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	/** Keep the explorer present as the Notist world's default sidebar
	 * tab — open it on load and after every world switch if missing. */
	private async ensureExplorer(): Promise<void> {
		if (this.world !== "notist") return;
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTIST_EXPLORER).length) {
			return;
		}
		await this.activateExplorer();
	}

	/** Open the .not file tree in the left sidebar (single reused leaf). */
	private async activateExplorer(): Promise<void> {
		if (this.world !== "notist") {
			new Notice("Switch to Notist World first");
			return;
		}
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_NOTIST_EXPLORER)[0] ?? null;
		if (!leaf) {
			const leftLeaf = workspace.getLeftLeaf(false);
			if (!leftLeaf) return;
			leaf = leftLeaf;
			await leftLeaf.setViewState({
				type: VIEW_TYPE_NOTIST_EXPLORER,
				active: true,
			});
		}
		workspace.revealLeaf(leaf);
	}

	private openNotistSymbols(): void {
		if (this.world !== "notist") return;
		new NotistSymbolModal(this).open();
	}

	/** Route every Quick Switcher entry point through Notist symbols in the
	 * Notist world, while preserving the core command exactly in Markdown. */
	private patchQuickSwitcher(): void {
		const registry = (
			this.app as unknown as {
				commands?: { commands?: Record<string, InternalCommand> };
			}
		).commands?.commands;
		const command = registry?.["switcher:open"];
		if (!command) {
			console.warn("Notist: cannot route Quick Switcher; core command is unavailable");
			return;
		}

		const originalCallback = command.callback;
		const originalCheckCallback = command.checkCallback;
		const wrappedCallback = originalCallback
			? () => {
					if (this.world === "notist") {
						this.openNotistSymbols();
						return;
					}
					return originalCallback.call(command);
				}
			: undefined;
		const wrappedCheckCallback = originalCheckCallback
			? (checking: boolean) => {
					if (this.world === "notist") {
						if (!checking) this.openNotistSymbols();
						return true;
					}
					return originalCheckCallback.call(command, checking);
				}
			: undefined;

		if (wrappedCallback) command.callback = wrappedCallback;
		if (wrappedCheckCallback) command.checkCallback = wrappedCheckCallback;
		this.register(() => {
			if (wrappedCallback && command.callback === wrappedCallback) {
				command.callback = originalCallback;
			}
			if (wrappedCheckCallback && command.checkCallback === wrappedCheckCallback) {
				command.checkCallback = originalCheckCallback;
			}
		});
	}

	/**
	 * Filter the command palette (ctrl+p) in the Notist world down to this
	 * plugin's commands, app-level commands (app:*) and the rare
	 * prefix-less ones — other Markdown-world namespaces (editor:,
	 * namespaces (editor:, workspace:, graph:, …) stay out. The palette
	 * modal re-reads getCommands() on every keystroke, so toggling the
	 * world takes effect immediately; Markdown world and the hotkeys
	 * settings (which read listCommands directly) are untouched. Internal
	 * API, restored on unload.
	 */
	private patchCommandPalette(): void {
		const palette = (
			this.app as unknown as {
				internalPlugins?: {
					getPluginById?: (id: string) => {
						instance?: {
							getCommands?: () => Array<{ id: string }>;
						};
					};
				};
			}
		).internalPlugins?.getPluginById?.("command-palette")?.instance;
		const original = palette?.getCommands;
		if (!palette || typeof original !== "function") {
			console.warn("Notist: cannot filter the command palette; core plugin is unavailable");
			return;
		}
		const wrapped = (): Array<{ id: string }> => {
			const commands: Array<{ id: string }> = original.call(palette);
			if (this.world !== "notist") return commands;
			return commands.filter(
				(command) =>
					command.id.startsWith(`${this.manifest.id}:`) ||
					command.id.startsWith("app:") ||
					!command.id.includes(":"),
			);
		};
		palette.getCommands = wrapped;
		this.register(() => {
			if (palette.getCommands === wrapped) delete palette.getCommands;
		});
	}

	/** Remove tabs produced by older experimental Explorer/Problems views. */
	private purgeLegacyLeaves(): void {
		for (const type of LEGACY_VIEW_TYPES) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) leaf.detach();
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

	/** Debounced layout snapshot; public because views with view-level state
	 * (explorer expansion) call it so getState() is re-saved promptly. */
	scheduleLayoutSave(): void {
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


	private async loadPluginData(): Promise<void> {
		const loaded = (await this.loadData()) as Record<string, unknown> &
			Partial<NotistPluginData>;
		// Settings before 2026-08-28 stored binary path + full argv (Zed-style,
		// with the trailing `lsp` subcommand); fold them into `notistCommand`.
		const legacyPath = loaded.lspBinaryPath as string | undefined;
		const legacyArgs = loaded.lspBinaryArgs as string[] | undefined;
		delete loaded.lspBinaryPath;
		delete loaded.lspBinaryArgs;
		this.data = Object.assign({}, DEFAULT_DATA, loaded);
		if (legacyPath !== undefined || legacyArgs !== undefined) {
			const args = [...(legacyArgs ?? [])];
			// The legacy argv had to include the subcommand; drop it wherever
			// it sits (typically right after a `--` near the end).
			const sub = args.indexOf("lsp");
			if (sub !== -1) args.splice(sub, 1);
			const path = legacyPath?.trim() || DEFAULT_DATA.notistCommand;
			this.data.notistCommand =
				[quoteArg(path), ...args].join(" ") || DEFAULT_DATA.notistCommand;
			await this.savePluginData();
		}
	}
}
