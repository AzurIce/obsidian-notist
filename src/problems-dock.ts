import { setIcon } from "obsidian";
import type NotistPlugin from "./main";
import type { LspDiagnostic } from "./lsp/protocol";

type SeverityFilter = "all" | "errors" | "warnings" | "info";

interface FilterChip {
	filter: SeverityFilter;
	label: string;
	pick(counts: {
		errors: number;
		warnings: number;
		infoHints: number;
		total: number;
	}): number;
}

/** Multiple candidate names per icon: lucide renames drift between
 * Obsidian releases; setIcon silently renders nothing on an unknown name. */
const SEVERITY_ICONS: Record<number, string[]> = {
	1: ["circle-alert", "alert-circle", "octagon-x", "x-octagon"],
	2: ["triangle-alert", "alert-triangle"],
	3: ["info"],
	4: ["lightbulb"],
};

function setIconTry(el: HTMLElement, names: string[]): void {
	for (const name of names) {
		setIcon(el, name);
		if (el.querySelector("svg")) return;
	}
}

function severityIconName(severity: number | undefined): string[] {
	return SEVERITY_ICONS[severity ?? 1] ?? SEVERITY_ICONS[1];
}

/**
 * Vault-wide diagnostics surface (single instance, not an ItemView — opening
 * must not create workspace tabs). Redesigned UI: per-file collapsible
 * groups, severity filter chips, iconed rows with full-message tooltips,
 * keyboard navigation, and persisted expand/collapse preference.
 */
export class NotistProblemsDock {
	private el: HTMLElement | null = null;
	private host: HTMLElement | null = null;
	private filter: SeverityFilter = "all";
	private readonly collapsedFiles = new Set<string>();
	private lastFocusedKey: string | null = null;

	constructor(
		private plugin: NotistPlugin,
		workspaceEl: HTMLElement,
	) {
		this.mount(workspaceEl);
	}

	/** (Re-)attach to the current edit root. World switches run
	 * changeLayout, which replaces .workspace-split.mod-root wholesale —
	 * the dock must move with it or it disappears until reload. */
	mount(workspaceEl: HTMLElement): void {
		this.unmount();
		const rootEl = workspaceEl.querySelector<HTMLElement>(
			".workspace-split.mod-root",
		);
		this.host = rootEl ?? workspaceEl;
		workspaceEl
			.querySelectorAll(".notist-problems-dock")
			.forEach((el) => el.remove());
		this.host.addClass("notist-problems-host");
		const el = this.host.createDiv("notist-problems-dock");
		el.setAttribute("role", "region");
		el.setAttribute("aria-label", "Notist Problems");
		el.addEventListener("keydown", (event) => this.onKeydown(event));
		// Remember the focused row across diagnostic-push re-renders.
		el.addEventListener("focusin", (event) => {
			const key = (event.target as HTMLElement).dataset?.key;
			if (key) this.lastFocusedKey = key;
		});
		this.el = el;
		this.render();
	}

	/** False after a layout change replaced the host subtree. */
	isMounted(): boolean {
		return this.el?.isConnected ?? false;
	}

	toggle(): void {
		this.setExpanded(!this.expanded);
	}

	reveal(): void {
		if (!this.expanded) this.setExpanded(true);
		else this.render();
	}

	unmount(): void {
		this.el?.remove();
		this.el = null;
		this.host?.removeClass("notist-problems-host", "notist-problems-expanded");
		this.host = null;
	}

	private get expanded(): boolean {
		return this.plugin.data.problemsExpanded;
	}

	private setExpanded(expanded: boolean): void {
		this.plugin.data.problemsExpanded = expanded;
		void this.plugin.savePluginData();
		this.render();
	}

	refresh(): void {
		this.render();
	}

	private onKeydown(event: KeyboardEvent): void {
		const el = this.el;
		if (!this.expanded || !el) return;
		if (event.key === "Escape") {
			event.preventDefault();
			const hadFocus = el.contains(document.activeElement);
			this.lastFocusedKey = null;
			this.setExpanded(false);
			if (hadFocus) el.focus({ preventScroll: true });
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const targets = Array.from(
			el.querySelectorAll<HTMLElement>(".notist-problem-row"),
		);
		if (!targets.length) return;
		event.preventDefault();
		const current = document.activeElement as HTMLElement | null;
		let index = current ? targets.indexOf(current) : -1;
		index =
			event.key === "ArrowDown"
				? Math.min(index + 1, targets.length - 1)
				: Math.max(index - 1, 0);
		targets[index]?.focus({ preventScroll: false });
	}

	private render(): void {
		const el = this.el;
		if (!el) return;
		const expanded = this.expanded;
		const scrollBox = el.querySelector(".notist-problems-list");
		const prevScrollTop = scrollBox instanceof HTMLElement ? scrollBox.scrollTop : 0;

		el.empty();
		el.toggleClass("is-collapsed", !expanded);
		el.toggleClass("is-expanded", expanded);
		el.tabIndex = -1;
		this.host?.toggleClass("notist-problems-expanded", expanded);

		const counts = this.countBySeverity();

		// ---- Header -------------------------------------------------------
		const header = el.createDiv("notist-problems-header");
		header.addEventListener("click", (event) => {
			// Chips own their clicks; anything else toggles the dock.
			if ((event.target as HTMLElement).closest(".notist-problems-chip")) return;
			this.toggle();
		});
		const title = header.createDiv("notist-problems-title");
		setIcon(title, "list-x");
		title.createSpan({ text: "Problems" });
		title.setAttribute("aria-label", "Notist Problems");

		if (expanded) {
			const chips = header.createDiv("notist-problems-chips");
			for (const chip of FILTER_CHIPS) {
				const n = chip.pick(counts);
				const el = chips.createEl("button", {
					cls: `notist-problems-chip is-${chip.filter}`,
					attr: { type: "button", "aria-pressed": String(this.filter === chip.filter) },
				});
				el.createSpan({ cls: "notist-problems-chip-label", text: chip.label });
				el.createSpan({ cls: "notist-problems-chip-count", text: String(n) });
				el.addEventListener("click", (event) => {
					event.stopPropagation();
					this.filter = this.filter === chip.filter ? "all" : chip.filter;
					this.render();
				});
			}
		} else {
			const summary = header.createSpan("notist-problems-summary");
			summary.setText(this.summaryText(counts));
			summary.setAttribute("aria-label", summary.textContent ?? "");
		}
		const chevron = header.createEl("button", {
			cls: "clickable-icon notist-problems-toggle",
			attr: {
				type: "button",
				"aria-label": expanded ? "Collapse problems" : "Expand problems",
				"aria-expanded": String(expanded),
			},
		});
		setIcon(chevron, expanded ? "chevron-down" : "chevron-up");

		if (!expanded) return;

		// ---- Body ----------------------------------------------------------
		const state = this.plugin.getLspDisplayState();
		if (state !== "ready") {
			const banner = el.createDiv("notist-problems-status");
			banner.addClass(`is-${state}`);
			const iconEl = banner.createSpan("notist-problems-status-icon");
			setIcon(iconEl, "server-off");
			banner.createSpan({
				text:
					state === "off"
						? "Language server is off — enable it from the LSP status menu."
						: state === "starting"
							? "Language server is starting…"
							: "Language server failed. Use the LSP status menu to restart.",
			});
		}

		const groups = this.filteredGroups();
		const list = el.createDiv("notist-problems-list");
		list.setAttribute("role", "list");

		if (state === "ready" && groups.length === 0) {
			const empty = list.createDiv("notist-problems-empty");
			const iconEl = empty.createSpan("notist-problems-empty-icon");
			setIcon(iconEl, "check-circle-2");
			empty.createSpan({
				text:
					counts.total === 0
						? "No problems in this vault."
						: "No problems match the current filter.",
			});
		}

		for (const [path, diagnostics] of groups) {
			this.renderFileGroup(list, path, diagnostics);
		}

		// Restore viewport stability across diagnostic-push re-renders.
		if (scrollBox instanceof HTMLElement && prevScrollTop > 0) {
			requestAnimationFrame(() => {
				scrollBox.scrollTop = prevScrollTop;
			});
		}
	}

	private renderFileGroup(
		parent: HTMLElement,
		path: string,
		diagnostics: LspDiagnostic[],
	): void {
		const relPath = this.plugin.lspDisplayPath(path);
		const segments = relPath.split("/");
		const base = segments.pop() ?? relPath;
		const dir = segments.join("/");
		const collapsedHere = this.collapsedFiles.has(path);
		const counts = countSeverity(diagnostics);

		const group = parent.createDiv("notist-problems-file");
		const fileHeader = group.createEl("button", {
			cls: "notist-problems-file-header",
			attr: { type: "button", "aria-expanded": String(!collapsedHere) },
		});
		const chev = fileHeader.createSpan("notist-problems-file-chevron");
		setIcon(chev, collapsedHere ? "chevron-right" : "chevron-down");
		fileHeader.createSpan({ cls: "notist-problems-file-name", text: base });
		if (dir) {
			fileHeader.createSpan({ cls: "notist-problems-file-dir", text: dir });
		}
		const badge = fileHeader.createSpan({
			cls: `notist-problems-file-count is-${toneForCounts(counts)}`,
			text: String(diagnostics.length),
		});
		badge.setAttribute("aria-label", `${diagnostics.length} problem(s)`);
		fileHeader.setAttribute("data-path", path);
		fileHeader.addEventListener("click", () => {
			if (collapsedHere) this.collapsedFiles.delete(path);
			else this.collapsedFiles.add(path);
			this.render();
		});

		if (!collapsedHere) {
			for (const diagnostic of diagnostics) {
				this.renderRow(group, path, diagnostic);
			}
		}
	}

	private renderRow(
		parent: HTMLElement,
		path: string,
		diagnostic: LspDiagnostic,
	): void {
		const row = parent.createEl("button", {
			cls: "notist-problem-row",
			attr: { type: "button" },
		});
		row.dataset.path = path;
		row.dataset.key = rowKey(path, diagnostic);
		const severity = diagnostic.severity ?? 1;
		row.addClass(`is-severity-${severity}`);

		const icon = row.createSpan({
			cls: `notist-problem-severity notist-diagnostic-severity-${severity}`,
		});
		icon.setAttribute("aria-label", severityAriaLabel(severity));
		setIconTry(icon, severityIconName(severity));

		row.createSpan({ cls: "notist-problem-message", text: diagnostic.message });
		if (diagnostic.source) {
			row.createSpan({
				cls: "notist-problem-source",
				text: diagnostic.source + (diagnostic.code !== undefined ? `(${diagnostic.code})` : ""),
			});
		} else if (diagnostic.code !== undefined) {
			row.createSpan({ cls: "notist-problem-source", text: `[${diagnostic.code}]` });
		}
		row.createSpan({
			cls: "notist-problem-position",
			text: `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
		});
		row.setAttribute("title", diagnostic.message);
		row.addEventListener("click", () => void this.plugin.openLspDiagnostic(path, diagnostic));
		if (row.dataset.key === this.lastFocusedKey) row.focus({ preventScroll: true });
	}


	private countBySeverity() {
		let errors = 0;
		let warnings = 0;
		let infoHints = 0;
		let total = 0;
		for (const [, diagnostics] of this.plugin.getLspDiagnosticsSnapshot()) {
			const c = countSeverity(diagnostics);
			errors += c.errors;
			warnings += c.warnings;
			infoHints += c.infoHints;
			total += c.total;
		}
		return { errors, warnings, infoHints, total };
	}

	private filteredGroups(): Array<[string, LspDiagnostic[]]> {
		const out: Array<[string, LspDiagnostic[]]> = [];
		for (const [path, diagnostics] of this.plugin.getLspDiagnosticsSnapshot()) {
			const filtered = diagnostics.filter((d) => this.matchesFilter(d));
			if (filtered.length) out.push([path, filtered]);
		}
		out.sort(([a], [b]) => a.localeCompare(b));
		for (const [, diagnostics] of out) {
			diagnostics.sort((x, y) =>
				x.range.start.line - y.range.start.line ||
				x.range.start.character - y.range.start.character,
			);
		}
		return out;
	}

	private matchesFilter(diagnostic: LspDiagnostic): boolean {
		switch (this.filter) {
			case "errors":
				return (diagnostic.severity ?? 1) === 1;
			case "warnings":
				return diagnostic.severity === 2;
			case "info":
				return (diagnostic.severity ?? 1) >= 3;
			default:
				return true;
		}
	}

	private summaryText(counts: {
		errors: number;
		warnings: number;
		infoHints: number;
		total: number;
	}): string {
		const parts: string[] = [];
		if (counts.errors) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
		if (counts.warnings) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
		if (counts.infoHints) parts.push(`${counts.infoHints} info`);
		if (!parts.length) return counts.total ? "Problems" : "No problems";
		return parts.join(", ");
	}
}

const FILTER_CHIPS: FilterChip[] = [
	{
		filter: "all",
		label: "All",
		pick: (c) => c.total,
	},
	{
		filter: "errors",
		label: "Errors",
		pick: (c) => c.errors,
	},
	{
		filter: "warnings",
		label: "Warnings",
		pick: (c) => c.warnings,
	},
	{
		filter: "info",
		label: "Info",
		pick: (c) => c.infoHints,
	},
];

function countSeverity(diagnostics: LspDiagnostic[]): {
	errors: number;
	warnings: number;
	infoHints: number;
	total: number;
} {
	const counts = { errors: 0, warnings: 0, infoHints: 0, total: diagnostics.length };
	for (const d of diagnostics) {
		switch (d.severity) {
			case 2:
				counts.warnings++;
				break;
			case 3:
			case 4:
				counts.infoHints++;
				break;
			default:
				counts.errors++;
		}
	}
	return counts;
}

function toneForCounts(counts: {
	errors: number;
	warnings: number;
}): "error" | "warning" | "info" {
	return counts.errors > 0 ? "error" : counts.warnings > 0 ? "warning" : "info";
}

function severityAriaLabel(severity: number): string {
	switch (severity) {
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "error";
	}
}

function rowKey(path: string, diagnostic: LspDiagnostic): string {
	return JSON.stringify([
		path,
		diagnostic.range.start.line,
		diagnostic.range.start.character,
		diagnostic.message,
	]);
}

function cssEscape(value: string): string {
	if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}
