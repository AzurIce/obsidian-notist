import { SourceMap } from "./lsp/source-map";
import { ItemView, Modal, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type NotistPlugin from "./main";
import type {
	LspDocumentReferenceItem,
	LspDocumentSymbol,
	LspLocation,
	LspSymbolInformation,
} from "./lsp/protocol";

export const VIEW_TYPE_NOTIST_OUTLINE = "notist-outline";
export const VIEW_TYPE_NOTIST_BACKLINKS = "notist-backlinks";
export const VIEW_TYPE_NOTIST_OUTGOING = "notist-outgoing-links";

/** Same drift guard as the dock: pick the first icon name that renders. */
function setIconTry(el: HTMLElement, names: string[]): void {
	for (const name of names) {
		setIcon(el, name);
		if (el.querySelector("svg")) return;
	}
}

function clearAndMessage(container: HTMLElement, message: string): void {
	container.empty();
	const box = container.createDiv("notist-semantic-empty");
	const icon = box.createSpan("notist-semantic-empty-icon");
	setIcon(icon, "circle-dashed");
	box.createSpan({ text: message });
}

function loadingMessage(container: HTMLElement, message: string): void {
	container.createDiv({
		cls: "notist-semantic-loading",
		text: message,
	});
}

/** Panel header strip: target file context + action buttons. */
function renderToolbar(
	container: HTMLElement,
	options: {
		targetLabel: string;
		iconName?: string;
		actions?: Array<{ iconNames: string[]; label: string; onClick: () => void }>;
	},
): HTMLElement {
	const toolbar = container.createDiv("notist-panel-toolbar");
	if (options.iconName) {
		const icon = toolbar.createSpan("notist-panel-toolbar-icon");
		setIcon(icon, options.iconName);
	}
	toolbar.createSpan({
		cls: "notist-panel-toolbar-target",
		text: options.targetLabel,
		title: options.targetLabel,
	});
	const actions = toolbar.createDiv("notist-panel-toolbar-actions");
	for (const action of options.actions ?? []) {
		const btn = actions.createEl("button", {
			cls: "clickable-icon notist-panel-action",
			attr: { type: "button", "aria-label": action.label },
		});
		setIconTry(btn, action.iconNames);
		btn.addEventListener("click", action.onClick);
	}
	return toolbar;
}

abstract class NotistSemanticView extends ItemView {
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, protected plugin: NotistPlugin) {
		super(leaf);
	}

	protected beginRender(): number {
		return ++this.renderToken;
	}

	protected isCurrent(token: number): boolean {
		return token === this.renderToken;
	}

	protected activePath(): string | null {
		return this.plugin.activeNotistPath();
	}

	protected registerRefresh(): void {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.render()));
		this.registerEvent(this.app.workspace.on("layout-change", () => void this.render()));
	}

	async refresh(): Promise<void> {
		await this.render();
	}

	protected abstract render(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export class NotistOutlineView extends NotistSemanticView {
	/** Collapsed section keys ("startLine:name"), session-scoped. */
	private readonly collapsed = new Set<string>();
	private flatRows: Array<{ el: HTMLElement; startLine: number }> = [];
	private activeRowKey: string | null = null;
	private unregisterCursor: (() => void) | null = null;

	getViewType(): string {
		return VIEW_TYPE_NOTIST_OUTLINE;
	}

	getDisplayText(): string {
		return "Notist outline";
	}

	getIcon(): string {
		return "list-tree";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notist-semantic-panel", "notist-outline-panel");
		this.registerRefresh();
		// Follow the caret: highlight the nearest heading at-or-above the
		// editor cursor and scroll it into view inside the outline.
		this.unregisterCursor = this.plugin.registerNotistCursorListener(
			(cursor) => {
				const active = this.activePath();
				if (!active || this.plugin.lspAbsPath(cursor.path) !== active) return;
				this.updateActiveHeading(cursor.line, true);
			},
		);
		await this.render();
	}

	async onClose(): Promise<void> {
		this.unregisterCursor?.();
		this.unregisterCursor = null;
	}

	protected async render(): Promise<void> {
		const token = this.beginRender();
		const container = this.contentEl;
		container.empty();
		container.addClass("notist-semantic-panel");
		const path = this.activePath();
		const session = this.plugin.getLspSession();

		if (!path || !session || session.state !== "ready") {
			this.renderToolbarChrome(container, null);
			clearAndMessage(container, "Open a .not file with Notist LSP enabled.");
			return;
		}
		this.renderToolbarChrome(container, path);
		loadingMessage(container, "Loading outline…");

		const symbols = await session.documentSymbols(path);
		if (!this.isCurrent(token)) return;
		container.empty();
		// Re-render chrome: actions close over the fresh render token.
		this.renderToolbarChrome(container, path);
		if (symbols === null) {
			clearAndMessage(container, "Outline unavailable.");
			return;
		}
		if (!symbols?.length) {
			clearAndMessage(container, "No headings in this document.");
			return;
		}
		this.flatRows = [];
		this.activeRowKey = null;
		const list = container.createEl("ul", { cls: "notist-symbol-tree" });
		list.setAttribute("role", "tree");
		this.renderSymbols(list, symbols, 0);

		// Restore the caret-tracked highlight after a data refresh, without
		// stealing scroll position.
		const cursorInfo = this.plugin.lastNotistCursor();
		if (
			cursorInfo &&
			cursorInfo.path &&
			this.plugin.lspAbsPath(cursorInfo.path) === path
		) {
			this.updateActiveHeading(cursorInfo.line, false);
		}
	}

	private collapsedAll(_token: number): void {
		for (const row of this.flatRows) {
			this.collapsed.add(row.el.dataset.sectionKey ?? "");
		}
		void this.render();
	}

	/** Toolbar chrome shared by every render branch of this view. */
	private renderToolbarChrome(
		container: HTMLElement,
		path: string | null,
	): void {
		renderToolbar(container, {
			targetLabel: path ? this.plugin.lspDisplayPath(path) : "No document",
			iconName: "list-tree",
			actions: path
				? [
					{
						iconNames: ["fold-vertical", "minimize-2"],
						label: "Collapse all",
						onClick: () => this.collapsedAll(0),
					},
					{
						iconNames: ["unfold-vertical", "maximize-2"],
						label: "Expand all",
						onClick: () => {
							this.collapsed.clear();
							void this.render();
						},
					},
					{
						iconNames: ["rotate-cw"],
						label: "Refresh",
						onClick: () => void this.render(),
					},
				]
			: [],
		});
	}

	private renderSymbols(
		parent: HTMLElement,
		symbols: LspDocumentSymbol[],
		depth: number,
	): void {
		for (const symbol of symbols) {
			const key = `${symbol.selectionRange.start.line}:${symbol.name}`;
			const item = parent.createEl("li", { cls: "notist-symbol-item" });
			item.setAttribute("role", "treeitem");
			const row = item.createEl("div", { cls: "notist-tree-row" });
			row.dataset.sectionKey = key;
			const hasChildren = !!symbol.children?.length;

			if (hasChildren) {
				const chevron = row.createSpan("notist-tree-chevron clickable-icon");
				setIcon(chevron, this.collapsed.has(key) ? "chevron-right" : "chevron-down");
				chevron.addEventListener("click", (event) => {
					event.stopPropagation();
					if (this.collapsed.has(key)) this.collapsed.delete(key);
					else this.collapsed.add(key);
					void this.render();
				});
			} else {
				row.createSpan("notist-tree-chevron notist-tree-chevron-spacer");
			}

			row.createSpan({ cls: "notist-tree-label", text: symbol.name });
			const levelMatch = symbol.detail?.match(/(\d+)/);
			if (levelMatch) {
				row.createSpan({ cls: "notist-tree-level", text: levelMatch[1] });
			}
			row.addEventListener("click", () => {
				const path = this.activePath();
				if (!path) return;
				void this.plugin.openLspLocation({
					uri: this.plugin.pathToLspUri(path),
					range: symbol.selectionRange,
				});
			});
			this.flatRows.push({ el: row, startLine: symbol.selectionRange.start.line });

			if (hasChildren && !this.collapsed.has(key)) {
				const children = item.createEl("ul", { cls: "notist-symbol-children" });
				children.setAttribute("role", "group");
				this.renderSymbols(children, symbol.children!, depth + 1);
			}
		}
	}

	/** Highlight the deepest known heading at-or-above `cursorLine`. */
	private updateActiveHeading(cursorLine: number, scroll: boolean): void {
		let best: { el: HTMLElement; startLine: number } | null = null;
		for (const row of this.flatRows) {
			if (row.startLine <= cursorLine) best = row;
			else break;
		}
		const key = best ? (best.el.dataset.sectionKey ?? null) : null;
		if (key === this.activeRowKey && !scroll) return;
		for (const row of this.flatRows) row.el.removeClass("is-active");
		if (!best || !key) return;
		best.el.addClass("is-active");
		this.activeRowKey = key;
		if (scroll) {
			best.el.scrollIntoView({ block: "nearest" });
		}
	}
}

// ---------------------------------------------------------------------------
// Backlinks / outgoing links (document-level references)
// ---------------------------------------------------------------------------

interface ReferenceExcerpt {
	lineIndex: number;
	before: string;
	mark: string;
	after: string;
	clippedBefore: boolean;
	clippedAfter: boolean;
}

abstract class NotistReferencesView extends NotistSemanticView {
	protected abstract direction(): "incoming" | "outgoing";
	protected abstract emptyMessage(): string;

	async onOpen(): Promise<void> {
		this.contentEl.addClass(
			"notist-semantic-panel",
			this.direction() === "incoming" ? "notist-backlinks-panel" : "notist-outgoing-panel",
		);
		this.registerRefresh();
		await this.render();
	}

	protected async render(): Promise<void> {
		const token = this.beginRender();
		const container = this.contentEl;
		container.empty();
		container.addClass("notist-semantic-panel");
		const path = this.activePath();
		const session = this.plugin.getLspSession();
		const iconName = this.direction() === "incoming" ? "links-coming-in" : "links-going-out";

		if (!path || !session || session.state !== "ready") {
			renderToolbar(container, { targetLabel: "No document", iconName });
			clearAndMessage(container, "Open a .not file with Notist LSP enabled.");
			return;
		}
		renderToolbar(container, { targetLabel: this.plugin.lspDisplayPath(path), iconName });
		loadingMessage(container, `Loading ${this.direction()} references…`);

		// Preferred protocol: module-level document references — no position
		// selector, so a document opening with a heading still resolves to its
		// module. Legacy fallback: position-based references at (0,0), which
		// the design doc documents as ambiguous but tolerable pre-upgrade.
		let items: LspDocumentReferenceItem[] | null = null;
		let degraded = false;
		if (session.supportsDocumentReferences()) {
			const result = await session.documentReferences(path, this.direction());
			if (!this.isCurrent(token)) return;
			items = result?.items.filter((item) => !item.isDefinition) ?? [];
		} else {
			const locations = await session.references(path, { line: 0, character: 0 }, false);
			if (!this.isCurrent(token)) return;
			degraded = true;
			// Legacy Location lacks target identity; render it position-only.
			items = (locations ?? []).map((location) => ({
				uri: location.uri,
				range: location.range,
				direction: this.direction(),
				sourceModule: "",
				targetModule: "",
				targetLabel: null,
				targetKind: null,
				url: null,
				isDefinition: false,
			}));
		}

		container.empty();
		renderToolbar(container, { targetLabel: this.plugin.lspDisplayPath(path), iconName });

		const filtered = items.filter((item) => item.direction === this.direction());
		if (!filtered.length) {
			clearAndMessage(container, this.emptyMessage());
			return;
		}

		const summary = container.createDiv("notist-backlinks-summary");
		summary.setText(
			`${filtered.length} reference${filtered.length === 1 ? "" : "s"}` +
				(degraded ? " · legacy mode (protocol extension unavailable)" : ""),
		);

		// Group: incoming by source document, outgoing by target module.
		const grouped = new Map<string, LspDocumentReferenceItem[]>();
		for (const item of filtered) {
			const key = this.direction() === "incoming"
				? item.uri
				: `${item.targetModule}\u0000${item.uri}`;
			const arr = grouped.get(key);
			if (arr) arr.push(item);
			else grouped.set(key, [item]);
		}
		const sortedGroups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));

		// Excerpts need source text; open editors provide the live overlay,
		// everything else falls back to the cached disk copy.
		const sourceUris = new Set<string>();
		for (const groupItems of grouped.values()) {
			for (const item of groupItems) sourceUris.add(item.uri);
		}
		const excerpts = new Map<string, string[]>();
		await Promise.all(
			[...sourceUris].map(async (uri) => {
				excerpts.set(uri, await this.readLines(uri));
			}),
		);

		const list = container.createDiv("notist-backlinks-groups");
		for (const [, groupItems] of sortedGroups) {
			this.renderGroup(list, groupItems, excerpts);
		}
	}

	private renderGroup(
		parent: HTMLElement,
		refs: LspDocumentReferenceItem[],
		excerpts: Map<string, string[]>,
	): void {
		const first = refs[0];
		let headerName: string;
		let headerDir = "";
		if (this.direction() === "incoming") {
			// Source-file grouping; label is the vault-relative file path.
			const label = this.plugin.locationLabel({ uri: first.uri, range: first.range }).replace(/:\d+$/, "");
			const segments = label.split("/");
			headerName = segments.pop() ?? label;
			headerDir = segments.join("/");
		} else {
			// Target-module grouping with nested-path breadcrumbs.
			const segments = first.targetModule.split("::");
			headerName = segments.pop() ?? first.targetModule;
			headerDir = segments.join(" :: ");
		}

		const group = parent.createDiv("notist-backlinks-group");
		const header = group.createDiv("notist-reference-file-header");
		const icon = header.createSpan("notist-reference-file-icon");
		setIcon(icon, this.direction() === "incoming" ? "file-code" : "arrow-up-right-square");
		header.createSpan({ cls: "notist-reference-file-name", text: headerName });
		if (headerDir) header.createSpan({ cls: "notist-reference-file-dir", text: headerDir });
		for (const kind of new Set(refs.map((r) => r.targetKind).filter(Boolean))) {
			header.createSpan({ cls: "notist-reference-kind", text: String(kind) });
		}
		header.createSpan({ cls: "notist-reference-file-count", text: String(refs.length) });

		const refList = group.createEl("ul", { cls: "notist-reference-list" });
		for (const ref of refs) {
			const lines = excerpts.get(ref.uri) ?? [];
			const excerpt = buildExcerpt(lines[ref.range.start.line] ?? "", { uri: ref.uri, range: ref.range });
			const row = refList.createEl("button", {
				cls: "notist-reference-row",
				attr: { type: "button" },
			});
			row.createSpan({ cls: "notist-reference-line", text: String(ref.range.start.line + 1) });
			const snippet = row.createSpan("notist-reference-excerpt");
			if (excerpt.clippedBefore) snippet.appendText("… ");
			snippet.appendText(excerpt.before);
			snippet.createSpan({ cls: "notist-ref-target", text: excerpt.mark });
			snippet.appendText(excerpt.after);
			if (excerpt.clippedAfter) snippet.appendText(" …");
			if (this.direction() === "outgoing") {
				row.createSpan({
					cls: "notist-reference-target-module",
					text: `→ ${ref.targetModule.split("::").pop() ?? ref.targetModule}`,
				});
			}
			row.title = lines[ref.range.start.line]?.trim() ?? "";
			row.addEventListener("click", () => void this.plugin.openLspLocation({ uri: ref.uri, range: ref.range }));
		}
	}

	/** Source lines for a reference URI: live overlay first, disk second. */
	private async readLines(uri: string): Promise<string[]> {
		const relPath = this.plugin.relativePathForUri(uri);
		if (!relPath) return [];
		const live = this.plugin.liveVaultFileText(relPath);
		if (live !== null) return live.split(/\r?\n/);
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (file instanceof TFile) {
			try {
				return (await this.app.vault.cachedRead(file)).split(/\r?\n/);
			} catch {
				return [];
			}
		}
		return [];
	}
}

export class NotistBacklinksView extends NotistReferencesView {
	getViewType(): string {
		return VIEW_TYPE_NOTIST_BACKLINKS;
	}

	getDisplayText(): string {
		return "Notist backlinks";
	}

	getIcon(): string {
		return "links-coming-in";
	}

	protected direction(): "incoming" | "outgoing" {
		return "incoming";
	}

	protected emptyMessage(): string {
		return "No incoming references.";
	}
}

export class NotistOutgoingLinksView extends NotistReferencesView {
	getViewType(): string {
		return VIEW_TYPE_NOTIST_OUTGOING;
	}

	getDisplayText(): string {
		return "Notist outgoing links";
	}

	getIcon(): string {
		return "links-going-out";
	}

	protected direction(): "incoming" | "outgoing" {
		return "outgoing";
	}

	protected emptyMessage(): string {
		return "No outgoing references.";
	}
}

function buildExcerpt(line: string, location: LspLocation): ReferenceExcerpt {
	const MAX = 120;
	// Wire character columns are utf-8 bytes; excerpts slice JS strings
	// (utf-16 units) — convert against the line itself.
	const start = SourceMap.utf16ColumnInLine(
		line,
		Math.max(0, location.range.start.character),
	);
	const end = SourceMap.utf16ColumnInLine(
		line,
		Math.max(start, location.range.end.character),
	);
	const beforeFull = line.slice(0, start);
	const mark = line.slice(start, end) || line.slice(start, start + 1);
	const afterFull = line.slice(Math.min(end, line.length));
	const overBudget = Math.max(0, beforeFull.length + afterFull.length - MAX);
	const beforeTake = Math.floor(overBudget / 2);
	const afterTake = overBudget - beforeTake;
	const clippedBefore = beforeFull.length > beforeTake + 12;
	const clippedAfter = afterFull.length > afterTake + 12;
	return {
		lineIndex: location.range.start.line,
		before: clippedBefore ? beforeFull.slice(-(beforeTake + 8)) : beforeFull,
		mark,
		after: clippedAfter ? afterFull.slice(0, afterTake + 8) : afterFull,
		clippedBefore,
		clippedAfter,
	};
}

// ---------------------------------------------------------------------------
// Workspace symbol palette
// ---------------------------------------------------------------------------

interface PaletteEntry {
	symbol: LspSymbolInformation;
	el: HTMLElement;
}

export class NotistSymbolModal extends Modal {
	private input: HTMLInputElement | null = null;
	private list: HTMLElement | null = null;
	private timer: number | null = null;
	private requestToken = 0;
	private entries: PaletteEntry[] = [];
	private selectedIndex = 0;

	constructor(private plugin: NotistPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.contentEl.addClass("notist-symbol-modal");
		this.modalEl.addClass("notist-symbol-modal-container");
		this.input = this.contentEl.createEl("input", {
			attr: { type: "search", placeholder: "Search modules and annotations…", spellcheck: "false" },
		});
		this.list = this.contentEl.createDiv("notist-symbol-results");
		this.input.addEventListener("input", () => this.scheduleSearch());
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				this.close();
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				this.moveSelection(1);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				this.moveSelection(-1);
			} else if (event.key === "Enter") {
				event.preventDefault();
				this.openSelected();
			}
		});
		this.input.focus();
		this.renderMessage("Type to search modules and annotations.");
	}

	onClose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.requestToken++;
		this.input = null;
		this.list = null;
		this.entries = [];
		this.contentEl.empty();
	}

	private moveSelection(delta: number): void {
		if (!this.entries.length) return;
		const next =
			(this.selectedIndex + delta + this.entries.length) % this.entries.length;
		this.setSelected(next, true);
	}

	private setSelected(index: number, scroll = false): void {
		this.selectedIndex = index;
		for (let i = 0; i < this.entries.length; i++) {
			this.entries[i].el.toggleClass("is-selected", i === index);
		}
		if (scroll) this.entries[index]?.el.scrollIntoView({ block: "nearest" });
	}

	private openSelected(): void {
		const entry = this.entries[this.selectedIndex];
		if (!entry) return;
		this.close();
		void this.plugin.openLspLocation(entry.symbol.location);
	}

	private scheduleSearch(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.search(this.input?.value.trim() ?? "");
		}, 120);
	}

	private async search(query: string): Promise<void> {
		const token = ++this.requestToken;
		if (!query) {
			this.renderMessage("Type to search modules and annotations.");
			return;
		}
		const session = this.plugin.getLspSession();
		if (!session || session.state !== "ready") {
			this.renderMessage("Notist LSP is unavailable.");
			return;
		}
		this.renderMessage("Searching…");
		const symbols = await session.workspaceSymbols(query);
		if (token !== this.requestToken) return;
		if (!symbols?.length) {
			this.renderMessage("No matching symbols.");
			return;
		}
		this.renderResults(symbols);
	}

	private renderResults(symbols: LspSymbolInformation[]): void {
		if (!this.list) return;
		this.list.empty();
		this.entries = symbols.map((symbol, index) => {
			const row = this.list!.createEl("button", {
				cls: "notist-symbol-result",
				attr: { type: "button" },
			});
			const icon = row.createSpan("notist-symbol-result-kind");
			setIcon(icon, symbol.kind === 1 ? "file-code" : "hash");
			row.createSpan({ cls: "notist-symbol-result-name", text: symbol.name });
			row.createSpan({
				cls: "notist-symbol-result-path",
				text: this.plugin.locationLabel(symbol.location),
			});
			row.addEventListener("mouseenter", () => this.setSelected(index));
			row.addEventListener("click", () => {
				this.close();
				void this.plugin.openLspLocation(symbol.location);
			});
			return { symbol, el: row };
		});
		this.selectedIndex = 0;
		this.setSelected(0);
	}

	private renderMessage(message: string): void {
		this.entries = [];
		this.selectedIndex = 0;
		this.list?.empty();
		const box = this.list?.createDiv("notist-semantic-empty");
		if (box) {
			const icon = box.createSpan("notist-semantic-empty-icon");
			setIcon(icon, "search");
			box.createSpan({ text: message });
		}
	}
}
