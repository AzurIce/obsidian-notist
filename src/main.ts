import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { NotistTextView, VIEW_TYPE_NOTIST } from "./notist-view";
import {
	NotistExplorerView,
	VIEW_TYPE_NOTIST_EXPLORER,
} from "./explorer-view";
import { NotistSettingTab } from "./settings";

type World = "md" | "notist";

interface NotistPluginData {
	world: World;
	/** aria-labels of ribbon icons that stay visible in the Notist world. */
	ribbonKeep: string[];
	/** Per-world workspace layout snapshots (same format as the Workspaces core plugin). */
	layouts: Partial<Record<World, unknown>>;
}

const TOGGLE_RIBBON_LABEL = "Toggle world (Markdown / Notist)";

const DEFAULT_DATA: NotistPluginData = {
	world: "md",
	ribbonKeep: [TOGGLE_RIBBON_LABEL],
	layouts: {},
};

export default class NotistPlugin extends Plugin {
	data: NotistPluginData = DEFAULT_DATA;
	private statusBarEl: HTMLElement | null = null;
	private ribbonObserver: MutationObserver | null = null;
	private switching = false;
	private layoutSaveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.registerView(VIEW_TYPE_NOTIST, (leaf) => new NotistTextView(leaf));
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

		this.applyWorld();
	}

	onunload(): void {
		void this.saveCurrentLayout();
		document.body.classList.remove("notist-world", "md-world");
	}

	get world(): World {
		return this.data.world;
	}

	async savePluginData(): Promise<void> {
		await this.saveData(this.data);
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
