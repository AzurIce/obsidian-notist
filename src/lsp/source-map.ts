/**
 * Byte offset/column ↔ LSP-style {line, character} mapping over one document
 * text.
 *
 * The wire protocol is UTF-8 only (byte columns), while CM6/JS positions count
 * UTF-16 code units — this converts between the two at the plugin↔LSP
 * boundary. Ported from vscode-notist/src/source-map.ts (byte offsets also
 * back the renderer's `data-notist-start`/`-end` attributes); kept free of
 * obsidian imports.
 */

export interface LspPosition {
	line: number;
	character: number;
}

const utf8BytesOf = (codePoint: number): number =>
	codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

export class SourceMap {
	private constructor(
		private readonly text: string,
		private readonly lineStartBytes: number[],
		private readonly lineStartChars: number[],
		private readonly totalByteLength: number,
	) {}

	static fromText(text: string): SourceMap {
		const lineStartBytes = [0];
		const lineStartChars = [0];
		let bytes = 0;
		let i = 0;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code === 0x0a) {
				bytes += 1;
				lineStartBytes.push(bytes);
				lineStartChars.push(i + 1);
				i += 1;
				continue;
			}
			const isPair =
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < text.length &&
				text.charCodeAt(i + 1) >= 0xdc00 &&
				text.charCodeAt(i + 1) <= 0xdfff;
			const codePoint = isPair ? text.codePointAt(i)! : code;
			bytes += utf8BytesOf(codePoint);
			i += isPair ? 2 : 1;
		}
		return new SourceMap(text, lineStartBytes, lineStartChars, bytes);
	}

	get lineCount(): number {
		return this.lineStartBytes.length;
	}

	/** Byte offset of the first character of `line` (clamped). */
	byteAtLine(line: number): number {
		return this.lineStartBytes[Math.max(0, Math.min(line, this.lineCount - 1))];
	}

	byteOfPosition(pos: LspPosition): number {
		const line = Math.max(0, Math.min(pos.line, this.lineCount - 1));
		const charStart = this.lineStartChars[line];
		// The trailing \n belongs to this line's byte run but is not content.
		const charEnd = line + 1 < this.lineCount ? this.lineStartChars[line + 1] - 1 : this.text.length;
		let byte = this.lineStartBytes[line];
		let utf16 = 0;
		let i = charStart;
		while (i < charEnd && utf16 < pos.character) {
			const code = this.text.charCodeAt(i);
			const isPair =
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < charEnd &&
				this.text.charCodeAt(i + 1) >= 0xdc00 &&
				this.text.charCodeAt(i + 1) <= 0xdfff;
			const codePoint = isPair ? this.text.codePointAt(i)! : code;
			byte += utf8BytesOf(codePoint);
			utf16 += isPair ? 2 : 1;
			i += isPair ? 2 : 1;
		}
		return byte;
	}

	/** Position of a byte offset. Offsets inside a code point snap to the
	 * position of that code point's first unit. */
	position(byteOffset: number): LspPosition {
		const target = Math.max(0, Math.min(byteOffset, this.totalByteLength));
		const starts = this.lineStartBytes;
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= target) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		let byte = starts[lo];
		let i = this.lineStartChars[lo];
		let utf16 = 0;
		while (i < this.text.length && byte < target) {
			const code = this.text.charCodeAt(i);
			if (code === 0x0a) break;
			const isPair =
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < this.text.length &&
				this.text.charCodeAt(i + 1) >= 0xdc00 &&
				this.text.charCodeAt(i + 1) <= 0xdfff;
			const codePoint = isPair ? this.text.codePointAt(i)! : code;
			if (byte + utf8BytesOf(codePoint) > target) break;
			byte += utf8BytesOf(codePoint);
			utf16 += isPair ? 2 : 1;
			i += isPair ? 2 : 1;
		}
		return { line: lo, character: utf16 };
	}

	/** UTF-8 byte column within `line` for a UTF-16 column (both clamped to
	 * the line's content). This is the outgoing wire conversion. */
	utf8ColumnOf(line: number, utf16Column: number): number {
		return this.byteOfPosition({ line, character: utf16Column }) - this.byteAtLine(line);
	}

	/** UTF-16 column within `line` for a UTF-8 byte column (both clamped; a
	 * byte column inside a code point snaps to its first unit). This is the
	 * incoming wire conversion. */
	utf16ColumnOf(line: number, utf8Column: number): number {
		const base = this.byteAtLine(line);
		return this.position(base + utf8Column).character;
	}

	/** Static variant of `utf16ColumnOf` for callers that only hold one line
	 * of text (excerpts, previews). */
	static utf16ColumnInLine(line: string, utf8Column: number): number {
		let byte = 0;
		let utf16 = 0;
		let i = 0;
		while (i < line.length && byte < utf8Column) {
			const code = line.charCodeAt(i);
			const isPair =
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < line.length &&
				line.charCodeAt(i + 1) >= 0xdc00 &&
				line.charCodeAt(i + 1) <= 0xdfff;
			const codePoint = isPair ? line.codePointAt(i)! : code;
			if (byte + utf8BytesOf(codePoint) > utf8Column) break;
			byte += utf8BytesOf(codePoint);
			utf16 += isPair ? 2 : 1;
			i += isPair ? 2 : 1;
		}
		return utf16;
	}
}
