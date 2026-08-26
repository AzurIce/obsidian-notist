/**
 * Minimal LSP 3.17 type surface — only what the notist server speaks
 * (FULL sync, UTF-16 positions, the semantic request methods + push diagnostics).
 * Hand-written to keep the plugin free of protocol dependencies.
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
