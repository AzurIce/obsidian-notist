import {
	RangeSetBuilder,
	StateField,
	type EditorState,
	type Extension,
} from "@codemirror/state";
import type { Text, Transaction } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
} from "@codemirror/view";
import { Language, Parser, Query } from "web-tree-sitter";
import type {
	Edit,
	Node,
	Point,
	QueryCapture,
	Tree,
} from "web-tree-sitter";

/**
 * Notist syntax highlighting: the tree-sitter-notist grammar (wasm) runs via
 * web-tree-sitter; captures from highlights.scm become `cm-notist-*` mark
 * decorations. Pure CM + web-tree-sitter — no obsidian imports, per the
 * shell/semantics layering discipline. The plugin shell loads the asset bytes
 * and hands them to initNotistHighlight; if that fails, highlighting stays
 * off and the editor falls back to plain text.
 *
 * web-tree-sitter indexes in UTF-16 code units (its parse callback marshals
 * with stringToUTF16), which aligns 1:1 with CM char offsets — no byte
 * conversion needed even for CJK content.
 */

export interface NotistHighlightAssets {
	/** tree-sitter.wasm (the web-tree-sitter runtime module). */
	runtime: ArrayBuffer;
	/** notist.wasm (the tree-sitter-notist grammar). */
	grammar: ArrayBuffer;
	/** highlights.scm source. */
	querySource: string;
}

let parser: Parser | null = null;
let query: Query | null = null;

/** One-shot global init; throws on wasm/ABI/query failure. */
export async function initNotistHighlight(
	assets: NotistHighlightAssets,
): Promise<void> {
	// wasmBinary skips emscripten's fetch/fs download path entirely.
	// locateFile is still required: findWasmBinary() runs unconditionally and
	// its fallback is `new URL("tree-sitter.wasm", import.meta.url)` — and
	// import.meta.url is empty in the esbuild CJS bundle (Invalid URL).
	// (EmscriptenModule comes from the optional @types/emscripten peer; the
	// cast keeps tsc honest without installing it.)
	await Parser.init({
		locateFile: (file: string) => file,
		wasmBinary: assets.runtime,
	} as Parameters<typeof Parser.init>[0]);
	const language = await Language.load(new Uint8Array(assets.grammar));
	const p = new Parser();
	p.setLanguage(language);
	parser = p;
	query = new Query(language, assets.querySource);
}

/** Free the shared parser/query (plugin unload). */
export function deinitNotistHighlight(): void {
	query?.delete();
	parser?.delete();
	query = null;
	parser = null;
}

export interface NotistTargetSpan {
	/** Whole `#<...>` literal, in UTF-16 code units (CM positions). */
	from: number;
	to: number;
	/** Body between the delimiters with target escapes (`\<` `\>` `\\`)
	 * resolved. */
	target: string;
}

/**
 * The `#<...>` target literal covering `pos`, read from the live parse tree
 * the highlight field maintains (no reparse). Null when highlighting failed
 * to init or `pos` sits outside any target literal.
 */
export function targetLiteralAt(
	state: EditorState,
	pos: number,
): NotistTargetSpan | null {
	const tree = state.field(highlightField, false)?.tree;
	if (!tree) return null;
	let node: Node | null = tree.rootNode.descendantForIndex(pos, pos);
	while (node && node.type !== "target_literal") node = node.parent;
	// The double negation also rejects NaN pos (e.g. from posAtCoords on a
	// hidden view), which passes both plain comparisons.
	if (!node || !(pos >= node.startIndex && pos < node.endIndex)) return null;
	const body = node.childForFieldName("target");
	if (!body) return null;
	return {
		from: node.startIndex,
		to: node.endIndex,
		target: state.doc
			.sliceString(body.startIndex, body.endIndex)
			.replace(/\\([<>\\])/g, "$1"),
	};
}

/** CM extension for one editor; empty when highlighting failed to init. */
export function notistHighlight(): Extension {
	if (!parser || !query) return [];
	return [highlightField, treeCleanup];
}

interface HighlightState {
	tree: Tree | null;
	deco: DecorationSet;
}

const highlightField = StateField.define<HighlightState>({
	create: (state) => parseAndDecorate(state.doc, null),

	update(value, tr) {
		if (!tr.docChanged) return value;
		let oldTree: Tree | null = value.tree;
		if (oldTree) {
			const edit = singleEdit(tr);
			if (edit) {
				oldTree.edit(edit);
			} else {
				// Multi-change transactions (multi-cursor typing etc.) would
				// need per-step coordinate mapping; full reparse is simpler
				// and cheap at .not document sizes.
				oldTree.delete();
				oldTree = null;
			}
		}
		return parseAndDecorate(tr.state.doc, oldTree);
	},

	provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Delete the live tree when the editor view is destroyed (wasm heap). */
const treeCleanup = ViewPlugin.fromClass(
	class {
		constructor(private view: EditorView) {}
		destroy() {
			this.view.state.field(highlightField, false)?.tree?.delete();
		}
	},
);

/** Parse `doc` (incrementally when `oldTree` is given) and decorate. */
function parseAndDecorate(
	doc: Text,
	oldTree: Tree | null,
): HighlightState {
	if (!parser || !query) return { tree: null, deco: Decoration.none };
	const tree = parser.parse(doc.toString(), oldTree);
	oldTree?.delete();
	if (!tree) return { tree: null, deco: Decoration.none };
	return { tree, deco: buildDecorations(tree) };
}

/**
 * The tree-sitter edit for a single-change transaction; null when the
 * transaction carries multiple changes (caller falls back to full reparse).
 * web-tree-sitter and CM share UTF-16 code-unit coordinates.
 */
function singleEdit(tr: Transaction): Edit | null {
	let edit: Edit | null = null;
	let count = 0;
	tr.changes.iterChanges((fromA, toA, fromB, toB) => {
		count++;
		edit = {
			startIndex: fromA,
			oldEndIndex: toA,
			newEndIndex: toB,
			startPosition: pointAt(tr.startState.doc, fromA),
			oldEndPosition: pointAt(tr.startState.doc, toA),
			newEndPosition: pointAt(tr.state.doc, toB),
		};
	});
	return count === 1 ? edit : null;
}

function pointAt(doc: Text, pos: number): Point {
	const line = doc.lineAt(pos);
	return { row: line.number - 1, column: pos - line.from };
}

/** capture name + node → CSS class(es); null skips the capture. */
function classFor(c: QueryCapture): string | null {
	// The query maps both italic-emphasis and underline to @emphasis;
	// split them by node type so underline stays an underline.
	if (c.name === "emphasis" && c.node.type === "underline") {
		return "cm-notist-underline";
	}
	const base = `cm-notist-${c.name.replace(/[._]/g, "-")}`;
	if (c.name === "title.markup") {
		const level = headingLevel(c.node);
		if (level) return `${base} cm-notist-heading-${level}`;
	}
	return base;
}

/** Heading level = number of `=` in the marker (the marker node includes
 *  the trailing space, so length alone is off by one). */
function headingLevel(node: Node): number | null {
	const heading = node.type === "heading" ? node : node.parent;
	if (!heading || heading.type !== "heading") return null;
	const marker = heading.childForFieldName("marker");
	const run = marker?.text.match(/^=+/);
	if (!run) return null;
	return Math.min(run[0].length, 6);
}

/**
 * Captures overlap freely (e.g. @string spans a whole string literal while
 * @string.escape covers an escape inside it), but RangeSetBuilder demands
 * sorted, disjoint ranges. Sweep capture boundaries into segments; each
 * segment carries the union of its covering captures' classes, so inner
 * captures win styling via later rules in styles.css.
 */
function buildDecorations(tree: Tree): DecorationSet {
	const spans: { from: number; to: number; cls: string }[] = [];
	for (const cap of query!.captures(tree.rootNode)) {
		const cls = classFor(cap);
		if (!cls) continue;
		const { startIndex: from, endIndex: to } = cap.node;
		if (to > from) spans.push({ from, to, cls });
	}
	if (spans.length === 0) return Decoration.none;

	const bounds = new Set<number>();
	for (const s of spans) {
		bounds.add(s.from);
		bounds.add(s.to);
	}
	const sorted = [...bounds].sort((a, b) => a - b);

	const builder = new RangeSetBuilder<Decoration>();
	let pendingFrom = -1;
	let pendingCls = "";
	const flush = (to: number) => {
		if (pendingFrom >= 0 && to > pendingFrom) {
			builder.add(pendingFrom, to, Decoration.mark({ class: pendingCls }));
		}
		pendingFrom = -1;
		pendingCls = "";
	};
	for (let i = 0; i + 1 < sorted.length; i++) {
		const from = sorted[i];
		const to = sorted[i + 1];
		let cls = "";
		for (const s of spans) {
			if (s.from <= from && s.to >= to) {
				cls = cls ? `${cls} ${s.cls}` : s.cls;
			}
		}
		if (!cls) {
			flush(from);
			continue;
		}
		// Merge adjacent segments with identical class sets.
		if (pendingFrom < 0 || cls !== pendingCls) {
			flush(from);
			pendingFrom = from;
			pendingCls = cls;
		}
	}
	flush(sorted[sorted.length - 1]);
	return builder.finish();
}
