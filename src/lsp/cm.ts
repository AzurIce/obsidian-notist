/**
 * CodeMirror side of the LSP integration: diagnostics rendering, completion,
 * hover, and go-to-definition. One extension set per editor view; the hooks
 * close over the view so position/path resolution always reflects its file.
 * No obsidian imports — shell wiring lives in main.ts / notist-view.ts.
 */
import type { Extension, Text } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import {
	linter,
	lintGutter,
	setDiagnostics,
	type Diagnostic as CmDiagnostic,
} from "@codemirror/lint";
import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
} from "@codemirror/autocomplete";
import type { NotistLspSession } from "./session";
import type {
	LspDiagnostic,
	LspLocation,
	LspPosition,
	LspRange,
} from "./protocol";

export interface LspCmHooks {
	/** Current session, or null when LSP is disabled/unavailable. */
	session(): NotistLspSession | null;
	/** Absolute path of this view's file, or null when untitled/unsaved. */
	path(): string | null;
	/** Shell action for a definition target (open file + reveal range). */
	openLocation(location: LspLocation): void;
}

/** UTF-16 code-unit offsets are shared by CM positions and LSP characters. */
export function posFromOffset(doc: Text, offset: number): LspPosition {
	const line = doc.lineAt(offset);
	return { line: line.number - 1, character: offset - line.from };
}

export function offsetFromPos(doc: Text, pos: LspPosition): number {
	const line = doc.line(Math.min(pos.line + 1, doc.lines));
	return Math.min(line.from + pos.character, line.to);
}

const SEVERITIES: Record<number, CmDiagnostic["severity"]> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

export function toCmDiagnostics(doc: Text, diags: LspDiagnostic[]): CmDiagnostic[] {
	return diags.map((d) => ({
		from: offsetFromPos(doc, d.range.start),
		to: offsetFromPos(doc, d.range.end),
		severity:
			d.severity !== undefined
				? (SEVERITIES[d.severity] ?? "error")
				: "error",
		message: d.code !== undefined ? `${d.message} [${d.code}]` : d.message,
		source: d.source,
	}));
}

/** Push the latest server diagnostics into one editor (delta model: the
 * array is already the complete current set for this file). */
export function applyLspDiagnostics(view: EditorView, diags: LspDiagnostic[]): void {
	view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diags)));
}

const COMPLETION_TYPES: Record<number, string> = {
	3: "function", // Function
	5: "property", // Field
	9: "namespace", // Module
	10: "property", // Property
	14: "keyword", // Keyword
	7: "class", // Class
	6: "method", // Method
	25: "type", // TypeParameter
};

export function notistLsp(hooks: LspCmHooks): Extension {
	const completionSource = async (
		ctx: CompletionContext,
	): Promise<CompletionResult | null> => {
		const session = hooks.session();
		const path = hooks.path();
		if (!session || session.state !== "ready" || !path) return null;
		const items = await session.completion(
			path,
			posFromOffset(ctx.state.doc, ctx.pos),
		);
		if (!items || ctx.aborted) return null;
		// The server sends an explicit replacement range per item; fall back
		// to the word under the cursor if it ever omits it.
		const word = ctx.state.wordAt(ctx.pos);
		const options: Completion[] = items.map((item) => {
			const option: Completion = {
				label: item.label,
				type:
					item.kind !== undefined
						? (COMPLETION_TYPES[item.kind] ?? "text")
						: "text",
				detail: item.detail,
			};
			if (item.textEdit) {
				const insert = item.textEdit.newText;
				option.apply = (view, _completion, from, to) => {
					view.dispatch({
						changes: { from, to, insert },
						selection: { anchor: from + insert.length },
						userEvent: "input.complete",
					});
				};
			}
			return option;
		});
		const from = items.reduce<number>((min, item) => {
			const start = item.textEdit
				? offsetFromPos(ctx.state.doc, item.textEdit.range.start)
				: (word?.from ?? ctx.pos);
			return Math.min(min, start);
		}, ctx.pos);
		return { from, options, validFor: /^[\w-]*$/ };
	};

	const hover = hoverTooltip(async (view, pos) => {
		const session = hooks.session();
		const path = hooks.path();
		if (!session || session.state !== "ready" || !path) return null;
		const result = await session.hover(path, posFromOffset(view.state.doc, pos));
		if (!result) return null;
		const text =
			typeof result.contents === "string"
				? result.contents
				: result.contents.value;
		if (!text) return null;
		const range: LspRange | undefined = result.range;
		return {
			pos: range ? offsetFromPos(view.state.doc, range.start) : pos,
			end: range ? offsetFromPos(view.state.doc, range.end) : undefined,
			create: () => {
				const dom = document.createElement("div");
				dom.addClass("notist-lsp-hover");
				// Server content is Markdown; render as plain text for now
				// (MarkdownRenderer belongs to the md world).
				dom.setText(text);
				return { dom };
			},
		};
	});

	const definitionKeymap = keymap.of([
		{
			key: "F12",
			run: (view) => {
				const session = hooks.session();
				const path = hooks.path();
				if (!session || session.state !== "ready" || !path) return false;
				const pos = view.state.selection.main.head;
				void session
					.definition(path, posFromOffset(view.state.doc, pos))
					.then((loc) => {
						if (loc) hooks.openLocation(loc);
					});
				return true;
			},
		},
	]);

	return [
		// Push model: null source installs the lint state field without an
		// active linter; real diagnostics arrive via setDiagnostics pushes.
		linter(null),
		lintGutter(),
		autocompletion({ override: [completionSource] }),
		hover,
		definitionKeymap,
	];
}
