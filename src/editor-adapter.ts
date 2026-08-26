import {
	Editor,
	type EditorCommandName,
	type EditorPosition,
	type EditorRange,
	type EditorRangeOrCaret,
	type EditorSelection,
	type EditorSelectionOrCaret,
	type EditorTransaction,
} from "obsidian";
import { EditorSelection as CmSelection } from "@codemirror/state";
import {
	cursorCharLeft,
	cursorCharRight,
	cursorGroupLeft,
	cursorGroupRight,
	cursorLineBoundaryBackward,
	cursorLineBoundaryForward,
	cursorLineDown,
	cursorLineUp,
	deleteLine,
	indentLess,
	indentMore,
	insertNewlineAndIndent,
	moveLineDown,
	moveLineUp,
	redo,
	undo,
} from "@codemirror/commands";
import { EditorView, type Command } from "@codemirror/view";

/** Obsidian's editor event APIs expect its Editor facade. This adapter keeps
 * those APIs usable from the standalone CodeMirror instance in a .not view. */
export class NotistEditorAdapter extends Editor {
	constructor(private readonly view: EditorView) {
		super();
	}

	getDoc(): this {
		return this;
	}

	refresh(): void {
		this.view.requestMeasure();
	}

	getValue(): string {
		return this.view.state.doc.toString();
	}

	setValue(content: string): void {
		this.view.dispatch({
			changes: { from: 0, to: this.view.state.doc.length, insert: content },
		});
	}

	getLine(line: number): string {
		return this.view.state.doc.line(this.clampLine(line) + 1).text;
	}

	lineCount(): number {
		return this.view.state.doc.lines;
	}

	lastLine(): number {
		return this.lineCount() - 1;
	}

	getSelection(): string {
		const { from, to } = this.view.state.selection.main;
		return this.view.state.sliceDoc(from, to);
	}

	getRange(from: EditorPosition, to: EditorPosition): string {
		return this.view.state.sliceDoc(this.posToOffset(from), this.posToOffset(to));
	}

	replaceSelection(replacement: string, _origin?: string): void {
		this.view.dispatch(this.view.state.replaceSelection(replacement));
	}

	replaceRange(
		replacement: string,
		from: EditorPosition,
		to: EditorPosition = from,
		_origin?: string,
	): void {
		this.view.dispatch({
			changes: {
				from: this.posToOffset(from),
				to: this.posToOffset(to),
				insert: replacement,
			},
		});
	}

	getCursor(side: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
		const selection = this.view.state.selection.main;
		const offset =
			side === "from"
				? selection.from
				: side === "to"
					? selection.to
					: side === "anchor"
						? selection.anchor
						: selection.head;
		return this.offsetToPos(offset);
	}

	listSelections(): EditorSelection[] {
		return this.view.state.selection.ranges.map((range) => ({
			anchor: this.offsetToPos(range.anchor),
			head: this.offsetToPos(range.head),
		}));
	}

	setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
		this.view.dispatch({
			selection: {
				anchor: this.posToOffset(anchor),
				head: this.posToOffset(head),
			},
		});
	}

	setSelections(ranges: EditorSelectionOrCaret[], main = 0): void {
		this.view.dispatch({
			selection: CmSelection.create(
				ranges.map((range) =>
					CmSelection.range(
						this.posToOffset(range.anchor),
						this.posToOffset(range.head ?? range.anchor),
					),
				),
				main,
			),
		});
	}

	focus(): void {
		this.view.focus();
	}

	blur(): void {
		const active = document.activeElement;
		if (active instanceof HTMLElement && this.view.dom.contains(active)) {
			active.blur();
		}
	}

	hasFocus(): boolean {
		return this.view.hasFocus;
	}

	getScrollInfo(): { top: number; left: number } {
		return {
			top: this.view.scrollDOM.scrollTop,
			left: this.view.scrollDOM.scrollLeft,
		};
	}

	scrollTo(x?: number | null, y?: number | null): void {
		this.view.scrollDOM.scrollTo({
			left: x ?? this.view.scrollDOM.scrollLeft,
			top: y ?? this.view.scrollDOM.scrollTop,
		});
	}

	scrollIntoView(range: EditorRange, center = false): void {
		const selection = CmSelection.range(
			this.posToOffset(range.from),
			this.posToOffset(range.to),
		);
		this.view.dispatch({
			effects: EditorView.scrollIntoView(selection, {
				y: center ? "center" : "nearest",
			}),
		});
	}

	undo(): void {
		undo(this.view);
	}

	redo(): void {
		redo(this.view);
	}

	exec(command: EditorCommandName): void {
		const commands: Partial<Record<EditorCommandName, Command>> = {
			goUp: cursorLineUp,
			goDown: cursorLineDown,
			goLeft: cursorCharLeft,
			goRight: cursorCharRight,
			goStart: cursorLineBoundaryBackward,
			goEnd: cursorLineBoundaryForward,
			goWordLeft: cursorGroupLeft,
			goWordRight: cursorGroupRight,
			indentMore,
			indentLess,
			newlineAndIndent: insertNewlineAndIndent,
			swapLineUp: moveLineUp,
			swapLineDown: moveLineDown,
			deleteLine,
		};
		commands[command]?.(this.view);
	}

	transaction(tx: EditorTransaction, _origin?: string): void {
		if (tx.replaceSelection !== undefined) {
			this.replaceSelection(tx.replaceSelection);
			return;
		}
		const changes = tx.changes?.map((change) => ({
			from: this.posToOffset(change.from),
			to: this.posToOffset(change.to ?? change.from),
			insert: change.text,
		}));
		const selections = tx.selections ?? (tx.selection ? [tx.selection] : undefined);
		this.view.dispatch({
			changes,
			selection: selections
				? CmSelection.create(
						selections.map((range) => this.cmRange(range)),
					)
				: undefined,
		});
	}

	wordAt(pos: EditorPosition): EditorRange | null {
		const line = this.getLine(pos.line);
		const ch = Math.min(Math.max(pos.ch, 0), line.length);
		const isWord = (value: string): boolean => /[\p{L}\p{N}_-]/u.test(value);
		if (!isWord(line[ch] ?? "") && !isWord(line[ch - 1] ?? "")) return null;
		let from = ch;
		let to = ch;
		while (from > 0 && isWord(line[from - 1])) from--;
		while (to < line.length && isWord(line[to])) to++;
		return { from: { line: pos.line, ch: from }, to: { line: pos.line, ch: to } };
	}

	posToOffset(pos: EditorPosition): number {
		const line = this.view.state.doc.line(this.clampLine(pos.line) + 1);
		return line.from + Math.min(Math.max(pos.ch, 0), line.length);
	}

	offsetToPos(offset: number): EditorPosition {
		const clamped = Math.min(Math.max(offset, 0), this.view.state.doc.length);
		const line = this.view.state.doc.lineAt(clamped);
		return { line: line.number - 1, ch: clamped - line.from };
	}

	private cmRange(range: EditorRangeOrCaret) {
		return CmSelection.range(
			this.posToOffset(range.from),
			this.posToOffset(range.to ?? range.from),
		);
	}

	private clampLine(line: number): number {
		return Math.min(Math.max(line, 0), this.view.state.doc.lines - 1);
	}
}
