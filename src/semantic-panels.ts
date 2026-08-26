import { ItemView, Modal, WorkspaceLeaf } from "obsidian";
import type NotistPlugin from "./main";
import type {
	LspDocumentSymbol,
	LspLocation,
	LspSymbolInformation,
} from "./lsp/protocol";

export const VIEW_TYPE_NOTIST_OUTLINE = "notist-outline";
export const VIEW_TYPE_NOTIST_BACKLINKS = "notist-backlinks";

function clearAndMessage(container: HTMLElement, message: string): void {
	container.empty();
	container.createDiv({ cls: "notist-semantic-empty", text: message });
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

export class NotistOutlineView extends NotistSemanticView {
	getViewType(): string {
		return VIEW_TYPE_NOTIST_OUTLINE;
	}

	getDisplayText(): string {
		return "Notist outline";
	}

	getIcon(): string {
		return "list";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notist-semantic-panel", "notist-outline-panel");
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
		if (!path || !session || session.state !== "ready") {
			clearAndMessage(container, "Open a .not file with Notist LSP enabled.");
			return;
		}
		container.createDiv({ cls: "notist-semantic-loading", text: "Loading outline..." });
		const symbols = await session.documentSymbols(path);
		if (!this.isCurrent(token)) return;
		container.empty();
		if (symbols === null) {
			clearAndMessage(container, "Outline unavailable.");
			return;
		}
		if (!symbols?.length) {
			clearAndMessage(container, "No headings in this document.");
			return;
		}
		const list = container.createEl("ul", { cls: "notist-symbol-tree" });
		this.renderSymbols(list, symbols);
	}

	private renderSymbols(parent: HTMLElement, symbols: LspDocumentSymbol[]): void {
		for (const symbol of symbols) {
			const item = parent.createEl("li", { cls: "notist-symbol-item" });
			const button = item.createEl("button", { cls: "notist-semantic-link" });
			button.setText(symbol.name);
			button.addEventListener("click", () => {
				const path = this.activePath();
				if (!path) return;
				void this.plugin.openLspLocation({
					uri: this.plugin.pathToLspUri(path),
					range: symbol.selectionRange,
				});
			});
			if (symbol.children?.length) {
				const children = item.createEl("ul", { cls: "notist-symbol-children" });
				this.renderSymbols(children, symbol.children);
			}
		}
	}
}

export class NotistBacklinksView extends NotistSemanticView {
	getViewType(): string {
		return VIEW_TYPE_NOTIST_BACKLINKS;
	}

	getDisplayText(): string {
		return "Notist backlinks";
	}

	getIcon(): string {
		return "links-coming-in";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notist-semantic-panel", "notist-backlinks-panel");
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
		if (!path || !session || session.state !== "ready") {
			clearAndMessage(container, "Open a .not file with Notist LSP enabled.");
			return;
		}
		container.createDiv({ cls: "notist-semantic-loading", text: "Loading backlinks..." });
		const locations = await session.references(path, { line: 0, character: 0 }, false);
		if (!this.isCurrent(token)) return;
		container.empty();
		if (locations === null) {
			clearAndMessage(container, "Backlinks unavailable.");
			return;
		}
		if (!locations?.length) {
			clearAndMessage(container, "No incoming references.");
			return;
		}
		const list = container.createEl("ul", { cls: "notist-reference-list" });
		for (const location of locations) {
			const item = list.createEl("li", { cls: "notist-reference-item" });
			const button = item.createEl("button", { cls: "notist-semantic-link" });
			button.setText(this.plugin.locationLabel(location));
			button.addEventListener("click", () => void this.plugin.openLspLocation(location));
		}
	}
}

export class NotistSymbolModal extends Modal {
	private input: HTMLInputElement | null = null;
	private list: HTMLElement | null = null;
	private timer: number | null = null;
	private requestToken = 0;

	constructor(private plugin: NotistPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.contentEl.addClass("notist-symbol-modal");
		this.input = this.contentEl.createEl("input", {
			attr: { type: "search", placeholder: "Search Notist symbols", spellcheck: "false" },
		});
		this.list = this.contentEl.createDiv("notist-symbol-results");
		this.input.addEventListener("input", () => this.scheduleSearch());
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.close();
		});
		this.input.focus();
		this.renderMessage("Type to search modules and headings.");
	}

	onClose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.requestToken++;
		this.input = null;
		this.list = null;
		this.contentEl.empty();
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
			this.renderMessage("Type to search modules and headings.");
			return;
		}
		const session = this.plugin.getLspSession();
		if (!session || session.state !== "ready") {
			this.renderMessage("Notist LSP is unavailable.");
			return;
		}
		this.renderMessage("Searching...");
		const symbols = await session.workspaceSymbols(query);
		if (token !== this.requestToken) return;
		if (!symbols?.length) {
			this.renderMessage("No matching symbols.");
			return;
		}
		if (!this.list) return;
		this.list.empty();
		for (const symbol of symbols) {
			const button = this.list.createEl("button", { cls: "notist-symbol-result" });
			button.createSpan({ cls: "notist-symbol-result-name", text: symbol.name });
			button.createSpan({ cls: "notist-symbol-result-path", text: this.plugin.locationLabel(symbol.location) });
			button.addEventListener("click", () => {
				this.close();
				void this.plugin.openLspLocation(symbol.location);
			});
		}
	}

	private renderMessage(message: string): void {
		this.list?.empty();
		this.list?.createDiv({ cls: "notist-semantic-empty", text: message });
	}
}
