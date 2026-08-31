/**
 * Minimal LSP 3.17 type surface — only what the notist server speaks
 * (INCREMENTAL sync — this client sends whole-document changes, which the
 * server still accepts; UTF-16 positions; the semantic request methods + push
 * diagnostics). Hand-written to keep the plugin free of protocol dependencies.
 */

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspDocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
	name: string;
	kind: number;
	location: LspLocation;
	containerName?: string;
}

/** One occurrence in a notist/documentReferences result. Positions follow
 * the LSP UTF-16 convention; target identity fields come from the resolved
 * reference index (direction relative to the queried document's module). */
export interface LspDocumentReferenceItem {
	uri: string;
	range: LspRange;
	direction: "incoming" | "outgoing";
	sourceModule: string;
	targetModule: string;
	targetName?: string | null;
	/** Outgoing only: "module" | "scope" | "resource". */
	targetKind?: string | null;
	url?: string | null;
	isDefinition: boolean;
}

export interface LspDocumentReferencesResult {
	revision: number;
	items: LspDocumentReferenceItem[];
}

/** One rendered heading with its HTML anchor (outline navigation). */
export interface LspRenderedHeading {
	level: number;
	id: string;
	text: string;
}

/** One module root binding (compact type/value summary). */
export interface LspRenderedBinding {
	name: string;
	detail: string;
}

/** One resource file of the rendered module; `sourcePath` is vault-absolute
 * and maps onto a TFile for `vault.getResourcePath` URL rewriting. */
export interface LspRenderedResource {
	moduleSegments: string[];
	name: string;
	/** "image" | "file". */
	kind: string;
	sourcePath: string;
}

/** Result of notist/renderDocument: the evaluated HTML fragment of the
 * document's owning module (same pipeline as the preview site) plus the
 * module-scoped metadata the preview view needs to compose it. */
export interface LspRenderDocumentResult {
	revision: number;
	page: {
		moduleSegments: string[];
		fragment: string;
		title: string | null;
		headings: LspRenderedHeading[];
		bindings: LspRenderedBinding[];
		source: string | null;
	};
	resources: LspRenderedResource[];
}

/** LSP DiagnosticSeverity: Error=1, Warning=2, Information=3, Hint=4. */
export interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
	code?: string | number;
	source?: string;
}

export interface LspCompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | { kind: string; value: string };
	textEdit?: { range: LspRange; newText: string };
}

export interface LspHover {
	contents:
		| string
		| { kind: string; value: string }
		| { language: string; value: string };
	range?: LspRange;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: LspDiagnostic[];
	version?: number | null;
}

/** Result of textDocument/completion: array or { items }. */
export type LspCompletionResult =
	| LspCompletionItem[]
	| { isIncomplete: boolean; items: LspCompletionItem[] }
	| null;
