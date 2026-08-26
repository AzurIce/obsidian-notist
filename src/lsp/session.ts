/**
 * LSP session: lifecycle, document registry, and request wrappers for one
 * `notist lsp` process covering the whole vault.
 *
 * Server contract this relies on (crates/notist-cli/src/lsp.rs @ 39f6086):
 * - FULL sync, strictly: didChange carries exactly one range-less change
 *   carrying the full text; document versions must be monotonic. Violations
 *   are rejected with only a server-side stderr log — no client feedback —
 *   so the sending discipline here is the only guard.
 * - Diagnostics are pushed: a baseline right after initialize, then deltas
 *   (unchanged files are not republished; cleared files get an empty set).
 * - Experimental `notist/documentReferences` (declared under
 *   capabilities.experimental.notist.documentReferences) resolves the module
 *   OWNING the document and returns every reference to/from it, without a
 *   position selector. The standard textDocument/references cannot express
 *   this: its position contract lands on whatever token sits at offset 0,
 *   so documents that open with a heading would resolve to the heading
 *   symbol instead of their module.
 * - $/cancelRequest is honoured best-effort (real cancellation only in the
 *   server's embedded mode; harmless otherwise).
 * No obsidian imports here; the shell layer lives in main.ts.
 */
import { LspTransport } from "./transport";
import type {
	LspCompletionItem,
	LspCompletionResult,
	LspDiagnostic,
	LspDocumentReferenceItem,
	LspDocumentReferencesResult,
	LspDocumentSymbol,
	LspHover,
	LspLocation,
	LspPosition,
	LspSymbolInformation,
	PublishDiagnosticsParams,
} from "./protocol";

export type LspState = "off" | "starting" | "ready" | "error";

export interface LspSessionHandlers {
	/** Delta push: apply as the per-path latest set, never a global replace. */
	onDiagnostics(path: string, diagnostics: LspDiagnostic[]): void;
	onState(state: LspState, detail?: string): void;
	/** Server stderr tail (also useful for spotting silent sync rejections). */
	onStderr(text: string): void;
	/** window/logMessage from the server (e.g. rejected didChange warnings).
	 * LSP MessageType: 1=Error, 2=Warning, 3=Info, 4=Log. */
	onLog?(type: number, message: string): void;
}

interface DocEntry {
	uri: string;
	version: number;
	/** Number of open editor views on this file (multi-leaf dedupe). */
	views: number;
	/** Last text actually sent to the server (didOpen/didChange). */
	text: string;
	/** Newest client-side text while a throttled didChange is pending. */
	pendingText: string | null;
	timer: number | null;
}

/** Trailing throttle for didChange; the server coalesces rebuilds itself, so
 * this only saves full-text traffic, it is not a correctness requirement. */
const DIDCHANGE_THROTTLE_MS = 200;

export function lspPathToUri(path: string): string {
	const { pathToFileURL } = require("url") as typeof import("url");
	return pathToFileURL(path).toString();
}

export function lspUriToPath(uri: string): string {
	const { fileURLToPath } = require("url") as typeof import("url");
	return fileURLToPath(uri);
}

export class NotistLspSession {
	state: LspState = "off";
	/** Raw server capabilities captured at initialize. */
	private serverCapabilities: unknown = null;
	private supportsDocumentReferencesCache: boolean | null = null;
	private transport: LspTransport | null = null;
	private docs = new Map<string, DocEntry>();
	private diagnostics = new Map<string, LspDiagnostic[]>();
	/** Latest in-flight completion/hover request ids per doc, for cancel. */
	private lastRequestId = new Map<string, number>();
	/** Deliberate shutdown: the exit that follows is not an error. */
	private stopping = false;
	/** Ring buffer of recent server stderr, surfaced in error details. */
	private stderrTail = "";

	constructor(
		private binaryPath: string,
		private binaryArgs: string[],
		private vaultRoot: string,
		private handlers: LspSessionHandlers,
	) {}

	private rememberStderr(text: string): void {
		this.stderrTail = (this.stderrTail + text).slice(-4000);
	}

	/** Recent server stderr (for the status-bar menu's "show stderr"). */
	getStderrTail(): string {
		return this.stderrTail;
	}

	async start(): Promise<void> {
		if (this.state !== "off" && this.state !== "error") return;
		this.stopping = false;
		this.stderrTail = "";
		this.setState("starting");
		const transport = new LspTransport(
			this.binaryPath,
			this.binaryArgs,
			{
				onNotification: (method, params) => this.onNotification(method, params),
				onExit: (code, signal) => {
					this.transport = null;
					if (!this.stopping) {
						const tail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
						this.setState(
							"error",
							`server exited (code ${code}, signal ${signal})` +
								(tail ? `\n${tail}` : ""),
						);
					}
				},
				onStderr: (text) => {
					this.rememberStderr(text);
					this.handlers.onStderr(text);
				},
			},
			// The server operates on the vault; its cwd is the vault root
			// (also the LSP convention). Launchers that need their own cwd
			// (e.g. `cargo run`) must say so in argv instead — see the
			// --manifest-path recipe in settings.
			this.vaultRoot,
		);
		try {
			await transport.start();
			const capabilities = (await transport.request("initialize", {
				processId: null,
				clientInfo: { name: "obsidian-notist" },
				rootUri: lspPathToUri(this.vaultRoot),
				workspaceFolders: [
					{ uri: lspPathToUri(this.vaultRoot), name: "vault" },
				],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					textDocument: {
						publishDiagnostics: {},
						completion: { completionItem: {} },
						hover: {},
						definition: {},
						references: {},
					},
				},
			})) as { capabilities?: unknown } | null;
			this.serverCapabilities = capabilities?.capabilities ?? null;
			transport.notify("initialized", {});
		} catch (e) {
			this.setState("error", e instanceof Error ? e.message : String(e));
			await transport.shutdown(500).catch(() => undefined);
			throw e;
		}
		this.transport = transport;
		this.setState("ready");
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const transport = this.transport;
		this.transport = null;
		this.docs.clear();
		this.lastRequestId.clear();
		if (transport) await transport.shutdown().catch(() => undefined);
		this.serverCapabilities = null;
		this.supportsDocumentReferencesCache = null;
		this.setState("off");
	}

	// ---- document registry ------------------------------------------------

	/** First view on a file opens the server-side document; later views only
	 * bump the refcount. `text` is the view's current content. Views that
	 * appear before the session is ready are (re-)registered by the shell
	 * layer once state becomes "ready". */
	viewOpened(path: string, text: string): void {
		if (this.state !== "ready") return;
		const entry = this.docs.get(path);
		if (entry) {
			entry.views++;
			return;
		}
		this.docs.set(path, {
			uri: lspPathToUri(path),
			version: 1,
			views: 1,
			text,
			pendingText: null,
			timer: null,
		});
		this.transport?.notify("textDocument/didOpen", {
			textDocument: {
				uri: lspPathToUri(path),
				languageId: "notist",
				version: 1,
				text,
			},
		});
	}

	/** A view's document changed (never for setViewData echoes — the view
	 * layer filters those). Throttled trailing; the version counter advances
	 * immediately so the registry always reflects the newest text. */
	docChanged(path: string, text: string): void {
		const entry = this.docs.get(path);
		if (!entry) return;
		entry.version++;
		entry.pendingText = text;
		if (entry.timer !== null) return; // trailing edge will send the latest
		entry.timer = window.setTimeout(() => {
			entry.timer = null;
			this.sendChange(path, entry);
		}, DIDCHANGE_THROTTLE_MS);
	}

	viewClosed(path: string): void {
		const entry = this.docs.get(path);
		if (!entry) return;
		entry.views--;
		if (entry.views > 0) return;
		if (entry.timer !== null) {
			window.clearTimeout(entry.timer);
			entry.timer = null;
			this.sendChange(path, entry); // flush so the server isn't left stale
		}
		this.docs.delete(path);
		this.transport?.notify("textDocument/didClose", {
			textDocument: { uri: entry.uri },
		});
	}

	/** File rename/delete outside the editor: close the old URI outright. */
	fileClosed(path: string): void {
		const entry = this.docs.get(path);
		if (!entry) return;
		if (entry.timer !== null) window.clearTimeout(entry.timer);
		this.docs.delete(path);
		this.transport?.notify("textDocument/didClose", {
			textDocument: { uri: entry.uri },
		});
	}

	fileRenamed(oldPath: string, newPath: string, text: string): void {
		const entry = this.docs.get(oldPath);
		if (!entry) return;
		if (entry.timer !== null) window.clearTimeout(entry.timer);
		this.docs.delete(oldPath);
		this.transport?.notify("textDocument/didClose", {
			textDocument: { uri: entry.uri },
		});
		const uri = lspPathToUri(newPath);
		this.docs.set(newPath, {
			uri,
			version: 1,
			views: entry.views,
			text,
			pendingText: null,
			timer: null,
		});
		this.transport?.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "notist", version: 1, text },
		});
	}

	/** Flush a pending didChange so a position-based request isn't answered
	 * against a stale server overlay. */
	flush(path: string): void {
		const entry = this.docs.get(path);
		if (!entry || entry.timer === null) return;
		window.clearTimeout(entry.timer);
		entry.timer = null;
		this.sendChange(path, entry);
	}

	private sendChange(path: string, entry: DocEntry): void {
		if (entry.pendingText === null || this.state !== "ready") return;
		const text = entry.pendingText;
		entry.pendingText = null;
		entry.text = text;
		this.transport?.notify("textDocument/didChange", {
			textDocument: { uri: entry.uri, version: entry.version },
			// FULL sync contract: exactly one change, no range.
			contentChanges: [{ text }],
		});
	}

	/** Content arriving via setViewData while registered: either an echo of
	 * our own save (text already known — skip) or a genuine external edit
	 * (sync/git/other plugin — forward). Overlay always wins over disk on the
	 * server, so external edits to open files must go through didChange. */
	externalChange(path: string, text: string): void {
		const entry = this.docs.get(path);
		if (!entry) return;
		if (text === (entry.pendingText ?? entry.text)) return; // save echo
		this.docChanged(path, text);
	}

	// ---- queries ------------------------------------------------------------

	async completion(
		path: string,
		position: LspPosition,
	): Promise<LspCompletionItem[] | null> {
		const result = await this.positionRequest<LspCompletionResult>(
			"completion",
			path,
			"textDocument/completion",
			position,
		);
		if (!result) return null;
		const items = Array.isArray(result) ? result : result.items;
		return items.length ? items : null;
	}

	async hover(path: string, position: LspPosition): Promise<LspHover | null> {
		return this.positionRequest<LspHover | null>(
			"hover",
			path,
			"textDocument/hover",
			position,
		);
	}

	async definition(
		path: string,
		position: LspPosition,
	): Promise<LspLocation | null> {
		const result = await this.positionRequest<
			LspLocation | LspLocation[] | { uri: string; range: LspLocation["range"] }[] | null
		>("definition", path, "textDocument/definition", position);
		if (!result) return null;
		const first = Array.isArray(result) ? result[0] : result;
		return first ?? null;
	}

	async documentSymbols(path: string): Promise<LspDocumentSymbol[] | null> {
		const entry = this.docs.get(path);
		if (!this.transport || !entry || this.state !== "ready") return null;
		this.flush(path);
		return this.queryRequest<LspDocumentSymbol[]>(
			`document-symbols:${path}`,
			"textDocument/documentSymbol",
			{ textDocument: { uri: entry.uri } },
		);
	}

	async workspaceSymbols(query: string): Promise<LspSymbolInformation[] | null> {
		if (!this.transport || this.state !== "ready") return null;
		return this.queryRequest<LspSymbolInformation[]>(
			"workspace-symbols",
			"workspace/symbol",
			{ query },
		);
	}

	/** Whether the experimental module-level documentReferences extension is
	 * available (negotiated once from the stored initialize result). Panels
	 * fall back to position-based references when it is not. */
	supportsDocumentReferences(): boolean {
		if (!this.transport || this.state !== "ready") return false;
		if (this.supportsDocumentReferencesCache === null) {
			const capabilities = this.serverCapabilities as {
				experimental?: {
					notist?: { documentReferences?: unknown };
				};
			} | null;
			this.supportsDocumentReferencesCache =
				capabilities?.experimental?.notist?.documentReferences !== undefined;
		}
		return this.supportsDocumentReferencesCache;
	}

	/** Module-level references for the document's owning module. Returns
	 * null only on transport failure or cancellation — an empty items array
	 * is the genuine "no references" answer. */
	async documentReferences(
		path: string,
		direction: "incoming" | "outgoing",
	): Promise<LspDocumentReferencesResult | null> {
		if (!this.transport || this.state !== "ready") return null;
		return this.queryRequest<LspDocumentReferencesResult>(
			`document-references:${direction}:${path}`,
			"notist/documentReferences",
			{
				textDocument: { uri: lspPathToUri(path) },
				direction,
			},
		);
	}

	async references(
		path: string,
		position: LspPosition,
		includeDeclaration = false,
	): Promise<LspLocation[] | null> {
		const entry = this.docs.get(path);
		if (!this.transport || !entry || this.state !== "ready") return null;
		this.flush(path);
		return this.queryRequest<LspLocation[] | null>(
			`references:${path}`,
			"textDocument/references",
			{
				textDocument: { uri: entry.uri },
				position,
				context: { includeDeclaration },
			},
		);
	}

	/** Position-based request with latest-wins cancellation: a newer request
	 * of the same kind on the same doc cancels and supersedes the older one. */
	private async positionRequest<T>(
		kind: string,
		path: string,
		method: string,
		position: LspPosition,
	): Promise<T | null> {
		const transport = this.transport;
		const entry = this.docs.get(path);
		if (!transport || !entry || this.state !== "ready") return null;
		this.flush(path);
		const key = `${kind}:${path}`;
		const previous = this.lastRequestId.get(key);
		if (previous !== undefined) transport.cancel(previous);
		const { id, promise } = transport.requestWithId(method, {
			textDocument: { uri: entry.uri },
			position,
		});
		this.lastRequestId.set(key, id);
		try {
			const result = (await promise) as T;
			// Superseded while in flight: drop the late result.
			if (this.lastRequestId.get(key) !== id) return null;
			return result;
		} catch {
			return null;
		} finally {
			if (this.lastRequestId.get(key) === id) this.lastRequestId.delete(key);
		}
	}

	private async queryRequest<T>(
		key: string,
		method: string,
		params: unknown,
	): Promise<T | null> {
		const transport = this.transport;
		if (!transport || this.state !== "ready") return null;
		const previous = this.lastRequestId.get(key);
		if (previous !== undefined) transport.cancel(previous);
		const { id, promise } = transport.requestWithId(method, params);
		this.lastRequestId.set(key, id);
		try {
			const result = (await promise) as T;
			if (this.lastRequestId.get(key) !== id) return null;
			return result;
		} catch {
			return null;
		} finally {
			if (this.lastRequestId.get(key) === id) this.lastRequestId.delete(key);
		}
	}

	// ---- diagnostics ---------------------------------------------------------

	diagnosticsFor(path: string): LspDiagnostic[] {
		return this.diagnostics.get(path) ?? [];
	}

	private onNotification(method: string, params: unknown): void {
		if (method === "window/logMessage") {
			const p = params as { type?: number; message?: string };
			if (typeof p.message === "string") {
				this.handlers.onLog?.(p.type ?? 4, p.message);
			}
			return;
		}
		if (method !== "textDocument/publishDiagnostics") return;
		const p = params as PublishDiagnosticsParams;
		let path: string;
		try {
			path = lspUriToPath(p.uri);
		} catch {
			return;
		}
		this.diagnostics.set(path, p.diagnostics);
		this.handlers.onDiagnostics(path, p.diagnostics);
	}

	private setState(state: LspState, detail?: string): void {
		this.state = state;
		this.handlers.onState(state, detail);
	}
}
