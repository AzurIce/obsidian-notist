import { setIcon } from "obsidian";
import type NotistPlugin from "./main";
import type { LspDiagnostic } from "./lsp/protocol";

const SEVERITY_LABELS: Record<number, string> = {
	1: "Error",
	2: "Warning",
	3: "Info",
	4: "Hint",
};

function severityLabel(severity: number | undefined): string {
	return SEVERITY_LABELS[severity ?? 1] ?? "Error";
}

/**
 * A single vault-wide diagnostics surface mounted outside Obsidian's leaf
 * layout. This deliberately does not register an ItemView, so opening it
 * cannot create a workspace tab or split.
 */
export class NotistProblemsDock {
	private readonly el: HTMLElement;
	private readonly host: HTMLElement;
	private collapsed = true;

	constructor(
		private plugin: NotistPlugin,
		workspaceEl: HTMLElement,
	) {
		const rootEl = workspaceEl.querySelector<HTMLElement>(
			".workspace-split.mod-root",
		);
		this.host = rootEl ?? workspaceEl;
		workspaceEl
			.querySelectorAll(".notist-problems-dock")
			.forEach((el) => el.remove());
		this.host.addClass("notist-problems-host");
		this.el = this.host.createDiv("notist-problems-dock");
		this.el.setAttribute("role", "region");
		this.el.setAttribute("aria-label", "Notist Problems");
		this.render();
	}

	toggle(): void {
		this.collapsed = !this.collapsed;
		this.render();
	}

	refresh(): void {
		this.render();
	}

	unmount(): void {
		this.el.remove();
		this.host.removeClass("notist-problems-host", "notist-problems-expanded");
	}

	private render(): void {
		this.el.empty();
		this.el.toggleClass("is-collapsed", this.collapsed);
		this.host.toggleClass("notist-problems-expanded", !this.collapsed);

		const counts = this.plugin.getLspDiagnosticCounts();
		const header = this.el.createDiv("notist-problems-header");
		const title = header.createDiv("notist-problems-title");
		setIcon(title, "list-x");
		title.createSpan({ text: "Problems" });
		const summary = header.createSpan("notist-problems-summary");
		summary.setText(
			`${counts.total} problems · ${counts.errors} errors · ${counts.warnings} warnings`,
		);
		const toggle = header.createEl("button", {
			cls: "clickable-icon notist-problems-toggle",
			attr: {
				type: "button",
				"aria-label": this.collapsed ? "Expand problems" : "Collapse problems",
				"aria-expanded": String(!this.collapsed),
			},
		});
		setIcon(toggle, this.collapsed ? "chevron-up" : "chevron-down");
		toggle.addEventListener("click", () => this.toggle());

		if (this.collapsed) return;

		const state = this.plugin.getLspDisplayState();
		if (state !== "ready") {
			const status = this.el.createDiv("notist-problems-status");
			status.addClass(`is-${state}`);
			status.setText(
				state === "off"
					? "Language server is disabled."
					: state === "starting"
						? "Language server is starting; diagnostics will appear here."
						: "Language server is unavailable. Open the LSP status menu to retry.",
			);
		}

		const groups = this.plugin
			.getLspDiagnosticsSnapshot()
			.filter(([, diagnostics]) => diagnostics.length > 0)
			.sort(([a], [b]) => a.localeCompare(b));
		if (groups.length === 0) {
			this.el
				.createDiv("notist-problems-empty")
				.setText(state === "ready" ? "No problems in this vault." : "No diagnostics available.");
			return;
		}

		const list = this.el.createDiv("notist-problems-list");
		for (const [path, diagnostics] of groups) {
			const group = list.createDiv("notist-problems-file");
			const fileHeader = group.createDiv("notist-problems-file-header");
			fileHeader.createSpan({
				cls: "notist-problems-file-path",
				text: this.plugin.lspDisplayPath(path),
			});
			fileHeader.createSpan({
				cls: "notist-problems-file-count",
				text: String(diagnostics.length),
			});
			for (const diagnostic of diagnostics) this.renderDiagnostic(group, path, diagnostic);
		}
	}

	private renderDiagnostic(
		parent: HTMLElement,
		path: string,
		diagnostic: LspDiagnostic,
	): void {
		const row = parent.createEl("button", {
			cls: "notist-problem-row",
			attr: { type: "button" },
		});
		row.createSpan({
			cls: `notist-problem-severity notist-diagnostic-severity-${diagnostic.severity ?? 1}`,
			text: severityLabel(diagnostic.severity),
		});
		row.createSpan({
			cls: "notist-problem-position",
			text: `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
		});
		row.createSpan({ cls: "notist-problem-message", text: diagnostic.message });
		if (diagnostic.code !== undefined) {
			row.createSpan({ cls: "notist-problem-code", text: `[${diagnostic.code}]` });
		}
		row.addEventListener("click", () => void this.plugin.openLspDiagnostic(path, diagnostic));
	}
}
