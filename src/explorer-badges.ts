import type NotistPlugin from "./main";
import type { LspDiagnostic } from "./lsp/protocol";

interface SeverityCounts {
	errors: number;
	warnings: number;
	infoHints: number;
	total: number;
}

/** Highest-severity presentation bucket for one aggregated entry. */
type BadgeTone = "error" | "warning" | "info";

function toneOf(counts: SeverityCounts): BadgeTone {
	if (counts.errors > 0) return "error";
	if (counts.warnings > 0) return "warning";
	return "info";
}

/**
 * Diagnostic badges in the shared native file explorer.
 *
 * Both worlds reuse Obsidian's native explorer (CSS-filtered), so decorating
 * its DOM once covers Markdown World and Notist World alike — independent of
 * the command-only `notist-explorer` placeholder view.
 *
 * Mechanism: a MutationObserver over `.nav-files-container` re-applies badges
 * whenever the tree re-renders (collapse/expand/rename/filter). Applying is
 * idempotent: existing badges are removed first, and the observer is
 * disconnected during application so the pass cannot feed back into itself.
 * Folders aggregate descendant totals (works for collapsed folders too,
 * because aggregation reads the diagnostics map, not the DOM).
 */
export class ExplorerDiagnosticBadges {
	private container: HTMLElement | null = null;
	private observer: MutationObserver | null = null;
	private applyTimer: number | null = null;
	/** Pending re-bind after a mid-layout sync found no explorer. */
	private retryTimer: number | null = null;
	/** Set by unmount: timers and re-binds must not outlive the plugin. */
	private stopped = false;

	constructor(private readonly plugin: NotistPlugin) {}

	/** Find the explorer container (re-)and start observing. Safe to repeat.
	 * Never tears down a live observer just because the explorer leaf is
	 * momentarily unfindable (mid-layout): a dead observer means expanded
	 * folders never get badges until the next diagnostics push. */
	sync(): void {
		const leaf = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0];
		const next =
			leaf?.view.containerEl.querySelector<HTMLElement>(".nav-files-container") ??
			document.querySelector<HTMLElement>(".nav-files-container");
		if (next === this.container && next !== null && this.observer) return;
		if (!next) {
			// Explorer missing right now (mid-layout). Keep the current setup
			// while it is still live; apply() heals a genuinely dead container.
			if (this.container?.isConnected && this.observer) return;
			this.stopObserving();
			this.container = null;
			// Layout is mid-swap; nothing else will re-trigger sync, so retry
			// until the explorer reappears (unmount cancels the timer).
			if (this.retryTimer === null && !this.stopped) {
				this.retryTimer = window.setTimeout(() => {
					this.retryTimer = null;
					this.sync();
				}, 300);
			}
			return;
		}
		this.stopObserving();
		this.container = next;
		// Remove badges left behind by a previous instance/container.
		next.querySelectorAll(".notist-nav-badge").forEach((el) => el.remove());
		next.addEventListener("mousedown", this.onInteract, true);
		next.addEventListener("click", this.onInteract, true);
		this.observer = new MutationObserver(() => this.scheduleApply());
		this.startObserving();
		this.scheduleApply();
	}

	unmount(): void {
		this.stopped = true;
		if (this.applyTimer !== null) {
			window.clearTimeout(this.applyTimer);
			this.applyTimer = null;
		}
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.stopObserving();
		const container = this.container;
		this.container = null;
		if (!container) return;
		container.removeEventListener("mousedown", this.onInteract, true);
		container.removeEventListener("click", this.onInteract, true);
		container.querySelectorAll(".notist-nav-badge").forEach((el) => el.remove());
	}

	private startObserving(): void {
		if (!this.observer) {
			// stopObserving() nulls the field before apply()'s finally calls
			// us — optional chaining alone would silently stay dead, and the
			// next tree re-render (folder expand) would never re-apply.
			if (this.stopped) return;
			this.observer = new MutationObserver(() => this.scheduleApply());
		}
		this.observer.observe(this.container ?? document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-path"],
		});
	}

	private stopObserving(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	refresh(): void {
		this.sync();
		this.scheduleApply();
	}

	private scheduleApply(): void {
		if (this.stopped) return;
		if (this.applyTimer !== null) window.clearTimeout(this.applyTimer);
		// Explorer re-renders come in bursts (folder expand renders several
		// siblings); debounce coalesces them into one DOM walk.
		this.applyTimer = window.setTimeout(() => {
			this.applyTimer = null;
			this.apply();
		}, 80);
	}

	private apply(): void {
		const container = this.container;
		// Self-heal: a dead container node (leaf recreation) or a missing
		// observer (mid-layout sync that found nothing) re-binds first.
		if (!container || !container.isConnected || !this.observer) {
			this.sync();
			if (!this.observer) return;
		}
		const live = this.container!;
		const perFile = this.collectPerFile();
		const anyExisting = live.querySelector(".notist-nav-badge") !== null;
		if (perFile.size === 0 && !anyExisting) return;

		// Observe nothing while we mutate — disconnect drops queued records,
		// so our own insertions never re-trigger this pass.
		this.stopObserving();
		try {
			live.querySelectorAll(".notist-nav-badge").forEach((el) => el.remove());
			if (perFile.size > 0) {
				const dirs = this.aggregateDirectories(perFile);
				this.decorateFiles(live, perFile);
				this.decorateFolders(live, dirs);
			}
		} finally {
			if (this.container === live) this.startObserving();
		}
	}

	/** Vault-relative path → aggregated counts for one file. */
	private collectPerFile(): Map<string, SeverityCounts> {
		const result = new Map<string, SeverityCounts>();
		for (const [absPath, diagnostics] of this.plugin.getLspDiagnosticsSnapshot()) {
			if (!diagnostics.length) continue;
			const rel = this.plugin.lspDisplayPath(absPath);
			let counts = result.get(rel);
			if (!counts) {
				counts = { errors: 0, warnings: 0, infoHints: 0, total: 0 };
				result.set(rel, counts);
			}
			for (const diagnostic of diagnostics) {
				counts.total++;
				switch (diagnostic.severity) {
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
		}
		return result;
	}

	/** Directory (and root "/") path → summed descendant counts. */
	private aggregateDirectories(
		perFile: Map<string, SeverityCounts>,
	): Map<string, SeverityCounts> {
		const dirs = new Map<string, SeverityCounts>();
		for (const [rel, counts] of perFile) {
			const segments = rel.split("/");
			for (let i = 1; i < segments.length; i++) {
				const dir = segments.slice(0, i).join("/");
				let acc = dirs.get(dir);
				if (!acc) {
					acc = { errors: 0, warnings: 0, infoHints: 0, total: 0 };
					dirs.set(dir, acc);
				}
				acc.errors += counts.errors;
				acc.warnings += counts.warnings;
				acc.infoHints += counts.infoHints;
				acc.total += counts.total;
			}
		}
		return dirs;
	}

	private decorateFiles(
		container: HTMLElement,
		perFile: Map<string, SeverityCounts>,
	): void {
		container
			.querySelectorAll<HTMLElement>(".nav-file-title[data-path]")
			.forEach((item) => {
				const counts = perFile.get(item.getAttribute("data-path") ?? "");
				if (!counts?.total) return;
				item.appendChild(this.badge(counts));
			});
	}

	private decorateFolders(
		container: HTMLElement,
		dirs: Map<string, SeverityCounts>,
	): void {
		container
			.querySelectorAll<HTMLElement>(".nav-folder-title[data-path]")
			.forEach((item) => {
				const path = item.getAttribute("data-path") ?? "";
				// Root ("/") already surfaces totals elsewhere (status bar); a
				// permanent badge on the vault header is noise.
				if (!path || path === "/") return;
				const counts = dirs.get(path.replace(/\/$/, ""));
				if (!counts?.total) return;
				item.appendChild(this.badge(counts));
			});
	}

	private badge(counts: SeverityCounts): HTMLElement {
		const badge = document.createElement("div");
		badge.addClass("notist-nav-badge", `is-${toneOf(counts)}`);
		badge.setText(String(counts.total));
		badge.setAttribute("aria-label", `${counts.total} problem(s)`);
		return badge;
	}

	/** Capture-phase intercept: badge clicks jump to the first diagnostic
	 * without triggering the explorer's own open/navigation handling. */
	private readonly onInteract = (event: MouseEvent): boolean => {
		const target = event.target instanceof Element ? event.target : null;
		const badge = target?.closest(".notist-nav-badge");
		if (!badge) return false;
		const item = badge.closest<HTMLElement>(".tree-item-self[data-path]");
		const rel = item?.getAttribute("data-path");
		if (!rel) return false;
		event.preventDefault();
		event.stopPropagation();
		void this.openFirstDiagnostic(rel);
		return true;
	};

	private async openFirstDiagnostic(relPath: string): Promise<void> {
		await this.plugin.openVaultRelativeDiagnostic(relPath);
	}
}
