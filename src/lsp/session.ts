/**
 * LSP session: lifecycle, document registry, and request wrappers for one
 * `notist lsp` process covering the whole vault.
 *
 * Server contract this relies on (crates/notist-cli/src/lsp.rs, 2026-08-30
 * incremental-sync state):
 * - INCREMENTAL sync: the server accepts ranged edits and whole-document
 *   replacements, mixed within one contentChanges array and applied in
 *   order. This client still sends exactly one range-less change with the
 *   full text (throttled), which remains valid; versions are informational
 *   only — the server applies in arrival order and records the latest
 *   version. Changes for documents that were never didOpen'd are dropped,
 *   and only URIs that cannot name a vault path log a client-visible
 *   warning.
 * - Position encoding is UTF-8 only: the server refuses sessions that do
 *   not offer utf-8 in general.positionEncodings (this client does). CM6
 *   positions count UTF-16 code units, so `SourceMap` converts columns at
 *   the boundary — outgoing positions carry utf-8 byte columns, incoming
 *   ranges are converted back before leaving this file.
 * - Completion trigger characters include "<" and "/" so module-path
 *   completion re-fires inside `#<path/name>` targets and import paths.
 * - Diagnostics are pushed: a baseline right after initialize, then deltas
 *   (unchanged files are not republished; cleared files get an empty set).
 * - Experimental `notist/documentReferences` (declared under
 *   capabilities.experimental.notist.documentReferences) resolves the module
 *   OWNING the document and returns every reference to/from it, without a
 *   position selector. The standard textDocument/references cannot express
 *   this: its position contract lands on whatever token sits at offset 0,
 *   so documents that open with a heading would resolve to the heading
 *   symbol instead of their module.
 * - Experimental `notist/renderDocument` (declared under
 *   capabilities.experimental.notist.renderDocument) renders the module
 *   OWNING the document to the evaluated HTML fragment the preview site
 *   would produce; the reply carries the snapshot revision as a freshness
 *   gate and the module's resource table.
 * - $/cancelRequest is honoured best-effort (real cancellation only in the
 *   server's embedded mode; harmless otherwise).
 * No obsidian imports here; the shell layer lives in main.ts.
 */
import { LspTransport } from "./transport";
import { SourceMap } from "./source-map";
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
	LspRenderDocumentResult,
	LspSymbolInformation,
	LspRange,
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
	/** Byte↔column map over `text`: converts wire (utf-8) columns and CM6
	 * (utf-16) columns at the boundary. */
	sentMap: SourceMap;
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
	private supportsRenderDocumentCache: boolean | null = null;
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
		private argv: string[],
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
		const [command = "notist", ...args] = this.argv;
		const transport = new LspTransport(
			command,
			args,
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
					general: { positionEncodings: ["utf-8"] },
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
		this.supportsRenderDocumentCache = null;
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
			sentMap: SourceMap.fromText(text),
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
			sentMap: SourceMap.fromText(text),
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
		entry.sentMap = SourceMap.fromText(text);
		this.transport?.notify("textDocument/didChange", {
			textDocument: { uri: entry.uri, version: entry.version },
			// Whole-document change (no range): still accepted under the
			// server's INCREMENTAL sync.
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
		const hover = await this.positionRequest<LspHover | null>(
			"hover",
			path,
			"textDocument/hover",
			position,
		);
		// Convert after the (flushing) request: the entry's map now matches
		// the text the server answered over.
		const sentMap = this.sentMapFor(path);
		if (!hover?.range || !sentMap) return hover;
		return { ...hover, range: this.wireRangeToClient(sentMap, hover.range) };
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

	/** Whether the experimental single-document render extension is available
	 * (negotiated once from the stored initialize result). The preview mode
	 * degrades to a notice when it is not. */
	supportsRenderDocument(): boolean {
		if (!this.transport || this.state !== "ready") return false;
		if (this.supportsRenderDocumentCache === null) {
			const capabilities = this.serverCapabilities as {
				experimental?: {
					notist?: { renderDocument?: unknown };
				};
			} | null;
			this.supportsRenderDocumentCache =
				capabilities?.experimental?.notist?.renderDocument !== undefined;
		}
		return this.supportsRenderDocumentCache;
	}

	/** Evaluated HTML fragment for the document's owning module. Flushes the
	 * pending didChange first so the fragment reflects the unsaved buffer;
	 * null on transport failure/cancellation (superseded renders drop). */
	async renderDocument(path: string): Promise<LspRenderDocumentResult | null> {
		const entry = this.docs.get(path);
		if (!this.transport || !entry || this.state !== "ready") return null;
		this.flush(path);
		return this.queryRequest<LspRenderDocumentResult>(
			`render-document:${path}`,
			"notist/renderDocument",
			{ textDocument: { uri: entry.uri } },
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
				position: {
					line: position.line,
					character: entry.sentMap.utf8ColumnOf(position.line, position.character),
				},
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
			position: {
				line: position.line,
				character: entry.sentMap.utf8ColumnOf(position.line, position.character),
			},
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
		const entry = this.docs.get(path);
		const diagnostics = entry
			? p.diagnostics.map((diagnostic) => ({
					...diagnostic,
					range: this.wireRangeToClient(entry.sentMap, diagnostic.range),
				}))
			: p.diagnostics;
		this.diagnostics.set(path, diagnostics);
		this.handlers.onDiagnostics(path, diagnostics);
	}

	/** Wire (utf-8 byte columns) range → client (utf-16 columns) range.
	 * Registered docs only: ranges for files the plugin has not opened stay
	 * in wire units until a consumer reads that file. */
	private wireRangeToClient(sentMap: SourceMap, range: LspRange): LspRange {
		return {
			start: { line: range.start.line, character: sentMap.utf16ColumnOf(range.start.line, range.start.character) },
			end: { line: range.end.line, character: sentMap.utf16ColumnOf(range.end.line, range.end.character) },
		};
	}

	/** The byte↔column map over the last text sent to the server for `path`,
	 * or null when the document is not open. Consumers of incoming wire
	 * positions (jumps into files opened on demand) rebuild a map from the
	 * file text at the point of use. */
	sentMapFor(path: string): SourceMap | null {
		return this.docs.get(path)?.sentMap ?? null;
	}

	private setState(state: LspState, detail?: string): void {
		this.state = state;
		this.handlers.onState(state, detail);
	}
}
