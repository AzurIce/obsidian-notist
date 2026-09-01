import {
	FileSystemAdapter,
	ItemView,
	Menu,
	Modal,
	Notice,
	Platform,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
	type App,
} from "obsidian";
import type NotistPlugin from "./main";
import { VIEW_TYPE_NOTIST } from "./notist-view";

export const VIEW_TYPE_NOTIST_EXPLORER = "notist-explorer";

/** Markdown family — hidden exactly like the CSS filter on the shared native
 * explorer hides it in the Notist world. Everything else shows. */
const HIDDEN_EXTENSIONS = new Set(["md", "markdown"]);

/** One visible entry of the tree, materialized from the vault. */
interface TreeNode {
	name: string;
	path: string;
	depth: number;
	isFolder: boolean;
	file?: TFile;
	children: TreeNode[];
	/** Aggregated problem counts including descendants. */
	counts: SeverityCounts;
	/** Files: extension is .not. Folders: subtree contains at least one .not. */
	hasNot: boolean;
}

interface SeverityCounts {
	errors: number;
	warnings: number;
	infoHints: number;
	total: number;
}

const EMPTY_COUNTS: SeverityCounts = { errors: 0, warnings: 0, infoHints: 0, total: 0 };

type Tone = "error" | "warning" | "info";

function severityTone(counts: SeverityCounts): Tone {
	if (counts.errors > 0) return "error";
	if (counts.warnings > 0) return "warning";
	return "info";
}

/**
 * Notist World's own file tree.
 *
 * A real hierarchical explorer in the vein of Zed/VSCode: folders expand and
 * collapse (state persists through world-switch layout snapshots via
 * getState/setState), rows rename inline, context menus create/move/delete,
 * keyboard navigation works end to end, and every row carries an aggregated
 * diagnostic pill fed straight from the plugin's LSP map — the native
 * explorer DOM is not involved anywhere.
 */
export class NotistExplorerView extends ItemView {
	private roots: TreeNode[] = [];
	private expanded = new Set<string>();
	/** When on, entries unrelated to .not (foreign files, empty folders) are
	 * grayed out instead of hidden. Persisted with the layout. */
	private dimNonNot = false;
	/** Keyboard/focus selection anchor. */
	private selectedPath: string | null = null;
	/** Path whose editor is open right now (row highlight). */
	private activePath: string | null = null;
	/** Diagnostics per vault-relative path, mirrored from the plugin. */
	private diagByPath = new Map<string, SeverityCounts>();
	/** Descendant-first jump order: errors rank above warnings above info. */
	private diagJumpOrder: string[] = [];
	/** Inline renames defer rerenders so typing never loses the input. */
	private renaming = false;
	private pendingRender = false;
	private renderQueued = false;
	/** Collapsed folder pending auto-open while dragging over it. */
	private dragOpen: { dir: string; timer: number } | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: NotistPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_NOTIST_EXPLORER;
	}

	getDisplayText(): string {
		return "Notist explorer";
	}

	getIcon(): string {
		return "folder-tree";
	}

	async onOpen(): Promise<void> {
		this.refreshDiagnostics();
		this.rebuildModel();
		this.render();

		this.registerEvent(this.app.vault.on("create", () => this.requestRender()));
		this.registerEvent(this.app.vault.on("delete", () => this.requestRender()));
		this.registerEvent(this.app.vault.on("rename", () => this.requestRender()));

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view as {
					getViewType?: () => string;
					file?: TFile;
				};
				const viewType = view?.getViewType?.();
				if (viewType === VIEW_TYPE_NOTIST && view.file) {
					this.activePath = view.file.path;
					this.reveal(view.file.path);
					return;
				}
				// Our own side panels (explorer/outline/backlinks) must not steal
				// the anchor — it sticks to the last focused .not file, like
				// VSCode's explorer tracking the active editor.
				if (viewType?.startsWith("notist-")) return;
				this.activePath = null;
			}),
		);

		// Seed the highlight for a file opened before this leaf existed.
		const active = this.app.workspace.activeLeaf?.view as
			| { getViewType?: () => string; file?: TFile }
			| undefined;
		if (active?.getViewType?.() === VIEW_TYPE_NOTIST && active.file) {
			this.activePath = active.file.path;
			this.reveal(active.file.path);
		}
	}

	getState(): Record<string, unknown> {
		return { expanded: [...this.expanded], dimNonNot: this.dimNonNot };
	}

	async setState(state: unknown): Promise<void> {
		const raw = (state ?? {}) as { expanded?: unknown; dimNonNot?: unknown };
		if (Array.isArray(raw.expanded)) {
			this.expanded = new Set(
				raw.expanded.filter((p): p is string => typeof p === "string"),
			);
		}
		if (typeof raw.dimNonNot === "boolean") this.dimNonNot = raw.dimNonNot;
		// During layout restore setState runs before onOpen; only rerender when
		// the tree is already on screen.
		if (this.contentEl.querySelector(".notist-explorer-tree")) {
			this.render();
		}
	}

	/** Reload the diagnostic overlay; the plugin calls this on every push. */
	refreshDiagnostics(): void {
		this.diagByPath.clear();
		this.diagJumpOrder = [];
		const base = this.plugin.vaultBaseAbsolutePath();
		if (!base) return;
		for (const [abs, diags] of this.plugin.getLspDiagnosticsSnapshot()) {
			if (!abs.startsWith(`${base}/`)) continue;
			const rel = abs.slice(base.length + 1);
			const counts: SeverityCounts = { errors: 0, warnings: 0, infoHints: 0, total: diags.length };
			for (const d of diags) {
				if (d.severity === 2) counts.warnings++;
				else if (d.severity === 3 || d.severity === 4) counts.infoHints++;
				else counts.errors++;
			}
			this.diagByPath.set(rel, counts);
			this.diagJumpOrder.push(rel);
		}
		const weight = (path: string): number => {
			const c = this.diagByPath.get(path) ?? EMPTY_COUNTS;
			return c.errors * 4 + c.warnings * 2 + c.infoHints;
		};
		this.diagJumpOrder.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
		this.requestRender();
	}

	// ---- model ----------------------------------------------------------------

	private isVisible(file: TFile): boolean {
		return !HIDDEN_EXTENSIONS.has(file.extension.toLowerCase());
	}

	private rebuildModel(): void {
		const countsOf = (path: string): SeverityCounts =>
			this.diagByPath.get(path) ?? { ...EMPTY_COUNTS };

		const buildFolder = (folder: TFolder, depth: number): TreeNode => {
			const node: TreeNode = {
				name: folder.name,
				path: folder.path,
				depth,
				isFolder: true,
				children: [],
				counts: { ...EMPTY_COUNTS },
				hasNot: false,
			};
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					const sub = buildFolder(child, depth + 1);
					node.children.push(sub);
				} else if (child instanceof TFile && this.isVisible(child)) {
					const isNot = child.extension === "not";
					if (isNot) node.hasNot = true;
					node.children.push({
						name: child.name,
						path: child.path,
						depth: depth + 1,
						isFolder: false,
						file: child,
						children: [],
						counts: countsOf(child.path),
						hasNot: isNot,
					});
				}
			}
			const byName = (a: TreeNode, b: TreeNode) =>
				a.name.localeCompare(b.name, undefined, { numeric: true });
			node.children.sort((a, b) =>
				a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : byName(a, b),
			);
			for (const child of node.children) {
				node.counts.errors += child.counts.errors;
				node.counts.warnings += child.counts.warnings;
				node.counts.infoHints += child.counts.infoHints;
				node.counts.total += child.counts.total;
				if (child.hasNot) node.hasNot = true;
			}
			return node;
		};

		const rootNode = buildFolder(this.app.vault.getRoot(), -1);
		this.roots = rootNode.children;
		// Re-rooted children were built at depth 0 relative to "/" — normalize
		// depths for rendering and aria-level.
		const normalizeDepth = (node: TreeNode, depth: number) => {
			node.depth = depth;
			for (const child of node.children) normalizeDepth(child, depth + 1);
		};
		for (const root of this.roots) normalizeDepth(root, 0);
	}

	// ---- rendering --------------------------------------------------------------

	/** Coalesce bursts of vault events into one render per microtask, and never
	 * wipe an inline rename mid-typing. */
	private requestRender(): void {
		if (this.renaming) {
			this.pendingRender = true;
			return;
		}
		if (this.renderQueued) return;
		this.renderQueued = true;
		Promise.resolve().then(() => {
			this.renderQueued = false;
			this.rebuildModel();
			this.render();
		});
	}

	private render(): void {
		// Every render starts from a fresh materialization so toggles, reveals
		// and diagnostic pushes all paint the same up-to-date counts.
		this.rebuildModel();
		const container = this.contentEl;
		const scrollTop = container.scrollTop;
		const hadFocus = container.contains(document.activeElement);
		container.empty();
		container.addClass("notist-explorer");

		const header = container.createDiv("notist-explorer-header");
		this.iconButton(
			header,
			"contrast",
			"Dim non-.not entries",
			() => this.toggleDim(),
			this.dimNonNot,
		);
		this.iconButton(header, "file-plus", "New .not file", () => void this.createFileIn(null));
		this.iconButton(header, "folder-plus", "New folder", () => void this.createFolderIn(null));
		this.iconButton(header, "locate", "Reveal active file", () => {
			if (this.activePath) this.reveal(this.activePath);
			else new Notice("Notist explorer: no active .not file");
		});
		this.iconButton(header, "chevrons-down-up", "Collapse all", () => {
			this.expanded.clear();
			this.render();
			this.saveExpansion();
		});

		const tree = container.createDiv("notist-explorer-tree");
		tree.setAttribute("role", "tree");
		tree.setAttribute("tabindex", "0");
		tree.addEventListener("keydown", (evt) => this.onKeyDown(evt));
		this.wireDropZone(tree);
		tree.addEventListener("contextmenu", (evt) => {
			if (evt.target instanceof Element && evt.target.closest(".notist-explorer-row")) return;
			evt.preventDefault();
			this.showFolderMenu(null, evt);
		});

		if (this.roots.length === 0) {
			container.createDiv("notist-explorer-empty").setText(
				"Nothing to show — no folders and no non-Markdown files.",
			);
			return;
		}

		for (const node of this.roots) this.renderNode(tree, node);

		container.scrollTop = scrollTop;
		if (hadFocus || !this.selectedPath) {
			tree.focus({ preventScroll: true });
		}
		const selected = this.selectedPath
			? this.contentEl.querySelector(`[data-path="${cssEscape(this.selectedPath)}"]`)
			: null;
		selected?.scrollIntoView({ block: "nearest" });
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
		pressed?: boolean,
	): void {
		const btn = parent.createEl("button", {
			cls: "clickable-icon",
			attr: pressed === undefined
				? { "aria-label": label }
				: { "aria-label": label, "aria-pressed": String(pressed) },
		});
		if (pressed) btn.addClass("is-toggled");
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
	}

	private toggleDim(): void {
		this.dimNonNot = !this.dimNonNot;
		this.render();
		this.plugin.scheduleLayoutSave();
	}

	private renderNode(parent: HTMLElement, node: TreeNode): void {
		if (!node.isFolder) {
			this.renderRow(parent, node);
			return;
		}
		const isOpen = this.expanded.has(node.path);
		// One wrapper per folder so its row and its children block share a
		// single box — that box is the region lit up as the drop target.
		const wrap = parent.createDiv("notist-explorer-node");
		const row = this.renderRow(wrap, node, { open: isOpen });
		row.setAttribute("aria-expanded", String(isOpen));
		if (!isOpen) return;
		const childrenHost = wrap.createDiv("notist-explorer-children");
		for (const child of node.children) this.renderNode(childrenHost, child);
	}

	private renderRow(
		parent: HTMLElement,
		node: TreeNode,
		opts: { open?: boolean } = {},
	): HTMLElement {
		const row = parent.createDiv("notist-explorer-row");
		row.setAttribute("role", "treeitem");
		row.setAttribute("aria-level", String(node.depth + 1));
		row.dataset.path = node.path;
		row.dataset.kind = node.isFolder ? "folder" : "file";
		row.style.setProperty("--notist-depth", String(node.depth));
		row.toggleClass("is-dimmed", this.dimNonNot && !node.hasNot);

		const chevron = row.createSpan("notist-explorer-chevron");
		if (node.isFolder) setIcon(chevron, "chevron-right");
		const iconEl = row.createSpan("notist-explorer-icon");
		if (node.isFolder) applyFolderIcon(iconEl, !!opts.open);
		else setIcon(iconEl, iconForFile(node.file));
		const label = row.createSpan("notist-explorer-label");
		label.setText(node.name);

		const counts = node.counts;
		if (counts.total > 0) {
			const badge = row.createSpan("notist-nav-badge");
			badge.addClass(`is-${severityTone(counts)}`);
			badge.setText(String(counts.total));
			badge.setAttribute("aria-label", `${counts.total} problem(s)`);
		}

		row.addEventListener("click", (evt) => {
			const hitBadge =
				evt.target instanceof Element && !!evt.target.closest(".notist-nav-badge");
			this.selectedPath = node.path;
			if (hitBadge) {
				void this.jumpToFirstProblem(node.path);
				return;
			}
			if (node.isFolder) {
				this.toggleFolder(node.path);
			} else if (node.file) {
				void this.app.workspace.getLeaf(false).openFile(node.file);
			}
		});

		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.selectedPath = node.path;
			if (node.isFolder) this.showFolderMenu(node, evt as MouseEvent);
			else this.showFileMenu(node, evt as MouseEvent);
		});

		this.wireDrag(row, node);
		return row;
	}

	/** Expand ancestors, select and scroll to a path. */
	private reveal(path: string): void {
		let current = "";
		for (const segment of path.split("/").slice(0, -1)) {
			current = current ? `${current}/${segment}` : segment;
			this.expanded.add(current);
		}
		this.selectedPath = path;
		this.render();
		this.contentEl
			.querySelector(`[data-path="${cssEscape(path)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}

	private toggleFolder(path: string): void {
		if (!this.expanded.delete(path)) this.expanded.add(path);
		this.render();
		this.saveExpansion();
	}

	private saveExpansion(): void {
		this.plugin.scheduleLayoutSave();
	}

	// ---- keyboard ---------------------------------------------------------------

	private onKeyDown(evt: KeyboardEvent): void {
		const rows = Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(".notist-explorer-row"),
		);
		if (!rows.length) return;
		const index = this.selectedPath
			? rows.findIndex((r) => r.dataset.path === this.selectedPath)
			: -1;

		switch (evt.key) {
			case "ArrowDown":
				this.focusRow(rows, index < 0 ? 0 : index + 1);
				break;
			case "ArrowUp":
				this.focusRow(rows, index <= 0 ? 0 : index - 1);
				break;
			case "Home":
				this.focusRow(rows, 0);
				break;
			case "End":
				this.focusRow(rows, rows.length - 1);
				break;
			case "ArrowRight":
			case "ArrowLeft": {
				const node = this.nodeAt(this.selectedPath);
				if (!node || !node.isFolder) break;
				const isOpen = this.expanded.has(node.path);
				if (evt.key === "ArrowRight") {
					if (!isOpen) this.toggleFolder(node.path);
					else this.focusRow(rows, index + 1);
				} else if (isOpen) {
					this.toggleFolder(node.path);
				} else if (index >= 0) {
					this.focusRow(rows, index - 1);
				}
				break;
			}
			case "Enter": {
				const node = this.nodeAt(this.selectedPath);
				if (!node) break;
				if (node.isFolder) this.toggleFolder(node.path);
				else if (node.file) void this.app.workspace.getLeaf(false).openFile(node.file);
				break;
			}
			case "F2":
				if (this.selectedPath) this.beginRename(this.selectedPath);
				break;
			case "Delete":
				if (this.selectedPath) this.confirmDelete(this.selectedPath);
				break;
			default:
				return;
		}
		evt.preventDefault();
	}

	private focusRow(rows: HTMLElement[], index: number): void {
		const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
		if (!row) return;
		this.selectedPath = row.dataset.path ?? null;
		row.scrollIntoView({ block: "nearest" });
	}

	// ---- menus -------------------------------------------------------------------

	private showFolderMenu(folder: TreeNode | null, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("New .not file").setIcon("file-plus").onClick(() => void this.createFileIn(folder)),
		);
		menu.addItem((item) =>
			item.setTitle("New folder").setIcon("folder-plus").onClick(() => void this.createFolderIn(folder)),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Collapse all")
				.setIcon("chevrons-down-up")
				.onClick(() => {
					this.expanded.clear();
					this.render();
					this.saveExpansion();
				}),
		);
		if (folder) {
			menu.addSeparator();
			this.addCopyPathItems(menu, folder.path);
			menu.addItem((item) =>
				item.setTitle("Rename").setIcon("pencil").onClick(() => this.beginRename(folder.path)),
			);
			menu.addItem((item) =>
				item.setTitle("Delete").setIcon("trash-2").onClick(() => this.confirmDelete(folder.path)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Reveal in system explorer")
					.setIcon("folder-open")
					.setDisabled(!this.canReachSystem())
					.onClick(() => this.revealInSystemExplorer(folder.path)),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** The file's canonical Notist ModulePath (`vault::a::b`): directory
	 * segments plus the file stem, except README.not which *is* its directory's
	 * module. Null for files that are not .not modules. */
	private modulePathOf(file: TFile): string | null {
		if (file.extension !== "not") return null;
		const dir = file.parent?.path ?? "";
		const segments = dir && dir !== "/" ? dir.split("/") : [];
		if (file.basename.toLowerCase() !== "readme") segments.push(file.basename);
		return ["vault", ...segments].join("::");
	}

	/** Native-style "Copy path" group: Notist ModulePath, vault-relative and
	 * absolute variants. When Obsidian's section submenus are available the
	 * short titles read as continuations of "Copy path", exactly like its own
	 * explorer menu; older builds fall back to flat, self-contained items.
	 * Vault paths are copied verbatim — markdown files (which Obsidian copies
	 * extension-less) never appear in this tree. */
	private addCopyPathItems(menu: Menu, path: string, file?: TFile): void {
		const withSubmenus = menu as Menu & {
			setSectionSubmenu?(
				section: string,
				submenu: { title: string | DocumentFragment; icon?: string },
			): Menu;
		};
		const asSubmenu = typeof withSubmenus.setSectionSubmenu === "function";
		if (asSubmenu) {
			withSubmenus.setSectionSubmenu!("info.copy", {
				title: "Copy path",
				icon: "lucide-clipboard",
			});
		}

		if (file) {
			const modulePath = this.modulePathOf(file);
			if (modulePath !== null) {
				menu.addItem((item) =>
					item
						.setTitle(asSubmenu ? "as Notist ModulePath" : "Copy Notist ModulePath")
						.setIcon("lucide-link")
						.setSection("info.copy")
						.onClick(() => this.copyToClipboard(modulePath)),
				);
			}
		}

		menu.addItem((item) =>
			item
				.setTitle(asSubmenu ? "from vault folder" : "Copy vault path")
				.setIcon("vault")
				.setSection("info.copy")
				.onClick(() => this.copyToClipboard(path)),
		);

		if (this.canReachSystem()) {
			const absolute = `${(this.app.vault.adapter as FileSystemAdapter).getBasePath()}/${path}`;
			menu.addItem((item) =>
				item
					.setTitle(asSubmenu ? "from system root" : "Copy full path")
					.setIcon("lucide-hard-drive")
					.setSection("info.copy")
					.onClick(() => this.copyToClipboard(absolute)),
			);
		}
	}

	private copyToClipboard(text: string): void {
		void navigator.clipboard.writeText(text);
		new Notice("Copied to your clipboard");
	}

	private showFileMenu(node: TreeNode, evt: MouseEvent): void {
		const menu = new Menu();
		if ((node.counts.total ?? 0) > 0) {
			menu.addItem((item) =>
				item
					.setTitle("Go to first problem")
					.setIcon("list-x")
					.onClick(() => void this.jumpToFirstProblem(node.path)),
			);
		}
		if (node.file) {
			menu.addItem((item) =>
				item
					.setTitle("Open")
					.setIcon("file")
					.onClick(() => void this.app.workspace.getLeaf(false).openFile(node.file!)),
			);
		}
		menu.addSeparator();
		this.addCopyPathItems(menu, node.path, node.file);
		menu.addItem((item) =>
			item.setTitle("Rename").setIcon("pencil").onClick(() => this.beginRename(node.path)),
		);
		menu.addItem((item) =>
			item.setTitle("Delete").setIcon("trash-2").onClick(() => this.confirmDelete(node.path)),
		);
		menu.addSeparator();
		const parentPath = this.parentPathOf(node.path);
		const parent = parentPath === null ? null : this.nodeAt(parentPath);
		menu.addItem((item) =>
			item
				.setTitle("New .not file here")
				.setIcon("file-plus")
				.onClick(() => void this.createFileIn(parent && parent.isFolder ? parent : null)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Reveal in system explorer")
				.setIcon("folder-open")
				.setDisabled(!this.canReachSystem())
				.onClick(() => this.revealInSystemExplorer(node.path)),
		);
		menu.showAtMouseEvent(evt);
	}

	// ---- inline rename --------------------------------------------------------------

	private beginRename(path: string): void {
		if (this.renaming) return;
		const row = this.contentEl.querySelector<HTMLElement>(`[data-path="${cssEscape(path)}"]`);
		const label = row?.querySelector<HTMLElement>(".notist-explorer-label");
		if (!row || !label) return;
		this.renaming = true;
		// The input replaces the label inside the draggable row, so a
		// text-selection drag in it bubbles a dragstart up and hauls the
		// file; park row dragging until the rename settles.
		row.draggable = false;

		const input = document.createElement("input");
		input.type = "text";
		input.value = label.textContent ?? "";
		input.className = "notist-explorer-rename";
		input.setAttribute("aria-label", "Rename");
		label.replaceWith(input);
		input.focus();
		// Preselect the stem before the extension (VSCode-style); folders and
		// dotfiles select everything.
		const name = input.value;
		const isFolder = row.dataset.kind === "folder";
		const cut = isFolder ? -1 : name.lastIndexOf(".");
		if (cut > 0) input.setSelectionRange(0, cut);
		else input.select();

		let finished = false;
		const finish = (commit: boolean) => {
			if (finished) return;
			finished = true;
			this.renaming = false;
			row.draggable = true;
			if (commit) {
				void this.commitRename(path, input.value.trim());
				return;
			}
			this.render();
			if (this.pendingRender) {
				this.pendingRender = false;
				this.requestRender();
			}
			this.contentEl
				.querySelector<HTMLElement>(".notist-explorer-tree")
				?.focus({ preventScroll: true });
		};
		input.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.key === "Enter") finish(true);
			else if (evt.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(false));
		input.addEventListener("click", (evt) => evt.stopPropagation());
	}

	private async commitRename(path: string, newName: string): Promise<void> {
		const node = this.nodeAt(path);
		if (!node) {
			this.render();
			return;
		}
		if (!newName || newName.includes("/")) {
			new Notice("Notist explorer: invalid name");
			this.render();
			return;
		}
		const parentPath = this.parentPathOf(path);
		const next = parentPath === null ? newName : `${parentPath}/${newName}`;
		if (next !== path && this.app.vault.getAbstractFileByPath(next)) {
			new Notice(`Notist explorer: "${newName}" already exists`);
			this.render();
			return;
		}
		if (next === path) {
			this.render();
			return;
		}
		const abstract = node.isFolder ? this.abstractAt(path) : node.file;
		if (!abstract) {
			this.render();
			return;
		}
		try {
			await this.app.vault.rename(abstract, next);
			// Folder renames move every descendant; remap expansion keys along.
			if (node.isFolder) {
				const remapped = new Set<string>();
				for (const key of this.expanded) {
					if (key === path) remapped.add(next);
					else if (key.startsWith(`${path}/`)) remapped.add(next + key.slice(path.length));
					else remapped.add(key);
				}
				this.expanded = remapped;
				this.saveExpansion();
			}
			if (this.selectedPath === path) this.selectedPath = next;
			if (this.activePath === path) this.activePath = next;
			// The vault 'rename' event triggers a render anyway; sync the model
			// immediately so the follow-up rename-highlight looks at fresh paths.
			this.pendingRender = false;
			this.render();
		} catch (e) {
			console.error("Notist explorer: rename failed", e);
			new Notice("Notist explorer: rename failed");
			this.render();
		}
	}

	// ---- creation / deletion ---------------------------------------------------------

	private nextAvailablePath(dir: string, name: string): string {
		const prefix = dir ? `${dir}/` : "";
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		let candidate = `${prefix}${name}`;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${prefix}${stem} ${i++}${ext}`;
		}
		return candidate;
	}

	private async createFileIn(folder: TreeNode | null): Promise<void> {
		const dir = folder?.path ?? "";
		try {
			const file = await this.app.vault.create(this.nextAvailablePath(dir, "Untitled.not"), "");
			this.expandAncestors(file.path);
			this.selectedPath = file.path;
			this.render();
			this.beginRename(file.path);
		} catch (e) {
			console.error("Notist explorer: create failed", e);
			new Notice("Notist explorer: could not create file");
		}
	}

	private async createFolderIn(folder: TreeNode | null): Promise<void> {
		const dir = folder?.path ?? "";
		try {
			const path = this.nextAvailablePath(dir, "New folder");
			await this.app.vault.createFolder(path);
			this.expandAncestors(path);
			this.expanded.add(path);
			this.selectedPath = path;
			this.render();
			this.beginRename(path);
		} catch (e) {
			console.error("Notist explorer: create folder failed", e);
			new Notice("Notist explorer: could not create folder");
		}
	}

	private expandAncestors(path: string): void {
		let current = "";
		for (const segment of path.split("/").slice(0, -1)) {
			current = current ? `${current}/${segment}` : segment;
			this.expanded.add(current);
		}
	}

	private confirmDelete(path: string): void {
		const node = this.nodeAt(path);
		if (!node) return;
		new ConfirmModal(
			this.app,
			node.isFolder ? `Delete folder "${node.name}"?` : `Delete "${node.name}"?`,
			"The item will be moved to the trash.",
			() => void this.trashNode(path),
		).open();
	}

	private async trashNode(path: string): Promise<void> {
		const abstract = this.nodeAt(path)?.file ?? this.abstractAt(path);
		if (!abstract) return;
		const useSystemTrash =
			this.trashOption() === "system" && Platform.isDesktopApp &&
			this.app.vault.adapter instanceof FileSystemAdapter;
		try {
			if (useSystemTrash) {
				await this.app.vault.adapter.trashSystem(abstract.path);
			} else {
				await this.app.vault.adapter.trashLocal(abstract.path);
			}
		} catch (e) {
			// System trash may be unavailable (headless mounts, network drives);
			// fall back to the in-vault trash rather than dropping the intent.
			try {
				await this.app.vault.adapter.trashLocal(abstract.path);
			} catch (e2) {
				console.error("Notist explorer: delete failed", e, e2);
				new Notice("Notist explorer: delete failed");
				return;
			}
		}
		this.forgetPathAndDescendants(path);
		this.requestRender();
	}

	private forgetPathAndDescendants(path: string): void {
		const matches = (candidate: string) =>
			candidate === path || candidate.startsWith(`${path}/`);
		if (this.selectedPath && matches(this.selectedPath)) this.selectedPath = null;
		if (this.activePath && matches(this.activePath)) this.activePath = null;
	}

	private trashOption(): "system" | "vault" {
		const configured = (
			this.app.vault as unknown as { getConfig?: (key: string) => string }
		).getConfig?.("trashOption");
		return configured === "system" ? "system" : "vault";
	}

	// ---- drag & drop ------------------------------------------------------------------

	/** Source path of the in-flight drag. The dataTransfer payload is unreadable
	 * during dragover (spec: types only until drop), so state lives here. */
	private dragSource: string | null = null;
	/** Drop region currently lit: the elements and the dir they represent. */
	private dropLit: { dir: string; els: HTMLElement[] } | null = null;

	private clearDropHighlight(): void {
		if (!this.dropLit) return;
		for (const el of this.dropLit.els) {
			el.removeClass("is-drop-target");
			el.removeClass("is-root-drop-target");
		}
		this.dropLit = null;
	}

	/** Light the region a drop into `dir` lands in: the whole tree for the
	 * vault root, otherwise the folder's wrapper box (row + children block). */
	private lightDropRegion(dir: string): void {
		if (this.dropLit?.dir === dir && this.dropLit.els.every((el) => el.isConnected)) return;
		this.clearDropHighlight();
		let el: HTMLElement | null = null;
		if (dir) {
			const row = this.contentEl.querySelector<HTMLElement>(`[data-path="${cssEscape(dir)}"]`);
			el =
				row?.parentElement instanceof HTMLElement &&
				row.parentElement.hasClass("notist-explorer-node")
					? row.parentElement
					: row ?? null;
		} else {
			el = this.contentEl.querySelector<HTMLElement>(".notist-explorer-tree");
		}
		if (!el) return;
		el.addClass(dir ? "is-drop-target" : "is-root-drop-target");
		this.dropLit = { dir, els: [el] };
	}

	private wireDrag(row: HTMLElement, node: TreeNode): void {
		row.draggable = true;
		row.addEventListener("dragstart", (evt) => {
			this.dragSource = node.path;
			evt.dataTransfer?.setData("application/x-notist-node", node.path);
			if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
			row.addClass("is-dragged");
		});
		row.addEventListener("dragend", () => {
			this.dragSource = null;
			row.removeClass("is-dragged");
			this.clearDropHighlight();
			this.cancelDragOpen();
		});
	}

	/** Nearest drop region for a pointer position, as a destination directory:
	 * a folder row (or anywhere inside its wrapper) takes the drop itself, a
	 * file row forwards to its parent folder, bare tree space is the root. */
	private dropDirAt(target: Element): string | null {
		const row = target.closest<HTMLElement>(".notist-explorer-row");
		if (row) {
			const path = row.dataset.path ?? "";
			return row.dataset.kind === "folder" ? path : this.parentPathOf(path) ?? "";
		}
		// Between rows inside a folder's wrapper (indent gutter, stray pixels,
		// rounded-corner slivers) is still that folder's region — it must not
		// fall through to the root, or the highlight flips on every crossing.
		const wrap = target.closest(".notist-explorer-node");
		const path = wrap?.querySelector<HTMLElement>(":scope > .notist-explorer-row")?.dataset.path;
		return path !== undefined ? path : "";
	}

	/** Hovering a collapsed folder long enough peeks it open, like Zed. */
	private scheduleDragOpen(dir: string): void {
		if (this.dragOpen?.dir === dir) return;
		this.cancelDragOpen();
		if (this.expanded.has(dir)) return;
		this.dragOpen = {
			dir,
			timer: window.setTimeout(() => {
				this.dragOpen = null;
				this.expanded.add(dir);
				this.render();
				this.lightDropRegion(dir);
				this.saveExpansion();
			}, 700),
		};
	}

	private cancelDragOpen(): void {
		if (this.dragOpen) window.clearTimeout(this.dragOpen.timer);
		this.dragOpen = null;
	}

	/** True only when dropping `source` into directory `dir` moves anything:
	 * not onto itself, not into its own subtree, and not back onto the spot it
	 * already occupies. Name clashes are handled later, in moveTo. */
	private canDropOn(source: string, dir: string): boolean {
		if (source === dir) return false;
		if (dir.startsWith(`${source}/`)) return false;
		const name = source.slice(source.lastIndexOf("/") + 1);
		return (dir ? `${dir}/${name}` : name) !== source;
	}

	/** All pointer feedback is delegated to the tree so crossing row boundaries
	 * never tears the highlight down mid-flight (clear-on-dragleave + relight
	 * on the next dragover read as background flicker between items). */
	private wireDropZone(tree: HTMLElement): void {
		tree.addEventListener("dragover", (evt) => {
			const source = this.dragSource;
			if (!source || !(evt.target instanceof Element)) return;
			const dir = this.dropDirAt(evt.target);
			if (dir === null || !this.canDropOn(source, dir)) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			this.lightDropRegion(dir);
			if (dir) this.scheduleDragOpen(dir);
		});
		tree.addEventListener("dragleave", (evt) => {
			const next = evt.relatedTarget;
			if (!(next instanceof Node) || !tree.contains(next)) {
				this.clearDropHighlight();
				this.cancelDragOpen();
			}
		});
		tree.addEventListener("drop", (evt) => {
			evt.preventDefault();
			this.cancelDragOpen();
			this.clearDropHighlight();
			const source =
				this.dragSource ?? evt.dataTransfer?.getData("application/x-notist-node") ?? null;
			this.dragSource = null;
			const dir = evt.target instanceof Element ? this.dropDirAt(evt.target) : null;
			if (source && dir !== null && this.canDropOn(source, dir)) {
				void this.moveTo(source, dir);
			}
		});
	}

	private async moveTo(sourcePath: string, targetDir: string): Promise<void> {
		const source = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!source) return;
		const name = sourcePath.split("/").pop() ?? sourcePath;
		const destination = targetDir ? `${targetDir}/${name}` : name;
		// Moves never auto-rename: a name clash cancels the move instead of
		// quietly spawning "name 1" (that suffixing is for creation only).
		if (this.app.vault.getAbstractFileByPath(destination)) {
			new Notice(`Notist explorer: "${name}" already exists in the target folder`);
			return;
		}
		try {
			await this.app.vault.rename(source, destination);
			this.expanded.add(targetDir);
			this.saveExpansion();
		} catch (e) {
			console.error("Notist explorer: move failed", e);
			new Notice("Notist explorer: move failed");
		}
	}

	// ---- helpers -----------------------------------------------------------------------

	private nodeAt(path: string | null): TreeNode | null {
		if (!path) return null;
		for (const root of this.roots) {
			const found = findNode(root, path);
			if (found) return found;
		}
		return null;
	}

	private abstractAt(path: string): TFolder | null {
		const found = this.app.vault.getAbstractFileByPath(path);
		return found instanceof TFolder ? found : null;
	}

	private parentPathOf(path: string): string | null {
		const cut = path.lastIndexOf("/");
		return cut === -1 ? null : path.slice(0, cut);
	}

	private canReachSystem(): boolean {
		return Platform.isDesktopApp && this.app.vault.adapter instanceof FileSystemAdapter;
	}

	private revealInSystemExplorer(path: string): void {
		if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
		try {
			const electron = (
				window as unknown as {
					require?: (mod: string) => {
						shell?: { showItemInFolder(abs: string): void };
					};
				}
			).require?.("electron");
			electron?.shell?.showItemInFolder(
				`${this.app.vault.adapter.getBasePath()}/${path}`,
			);
		} catch (e) {
			console.error("Notist explorer: reveal failed", e);
		}
	}

	/** Badge/menu action: open the most problematic file under `path` at its
	 * first diagnostic. Exact match wins over descendants. */
	private async jumpToFirstProblem(path: string): Promise<void> {
		const target =
			this.diagJumpOrder.find((candidate) => candidate === path) ??
			this.diagJumpOrder.find((candidate) => candidate.startsWith(`${path}/`));
		if (!target) return;
		await this.plugin.openVaultRelativeDiagnostic(target);
		this.reveal(target);
	}
}

function findNode(node: TreeNode, path: string): TreeNode | null {
	if (node.path === path) return node;
	for (const child of node.children) {
		const found = findNode(child, path);
		if (found) return found;
	}
	return null;
}

/** Closed vs open folder, inlined verbatim. Obsidian's bundled lucide renders
 * "folder" and "folder-open" nearly identically, so the exact glyph pair is
 * shipped here instead of trusting the registry. */
const FOLDER_PATHS: Record<"closed" | "open", string> = {
	closed:
		'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
	open: "m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2",
};

function applyFolderIcon(host: HTMLElement, open: boolean): void {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", open ? FOLDER_PATHS.open : FOLDER_PATHS.closed);
	svg.appendChild(path);
	host.empty();
	host.appendChild(svg);
}

function iconForFile(file: TFile | undefined): string {
	if (!file) return "file";
	return file.extension === "not" ? "file-code-2" : "file";
}

function cssEscape(value: string): string {
	return typeof CSS !== "undefined" && CSS.escape
		? CSS.escape(value)
		: value.replace(/["\\]/g, "\\$&");
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		title: string,
		body: string,
		onConfirm: () => void,
	) {
		super(app);
		this.titleEl.setText(title);
		this.contentEl.createDiv("notist-confirm-body").setText(body);
		const buttons = this.contentEl.createDiv("notist-confirm-buttons");
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const confirm = buttons.createEl("button", {
			text: "Move to trash",
			cls: "mod-warning",
		});
		confirm.addEventListener("click", () => {
			this.close();
			onConfirm();
		});
	}
}
