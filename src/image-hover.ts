/**
 * Image-reference hover: detects the pointer moving onto a `#<...>` target
 * literal whose ItemName (after the first `/`) names an image resource, and
 * hands the hit to the shell hook (notist-view.ts resolves it to a vault
 * file and opens a native HoverPopover). Pure CM + web-tree-sitter — no
 * obsidian imports, per the shell/semantics layering discipline.
 *
 * There is deliberately no dwell timer here: the native HoverPopover waits
 * `waitTime` (300ms) before showing and re-checks the pointer every 500ms,
 * hiding itself once the pointer leaves the target — the same recipe core
 * page preview uses. A CM-side dwell would only double the delay, and a
 * zero-wait popover re-hides on the first pointer twitch.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { targetLiteralAt } from "./highlight";

/** Mirrors notist's ResourceKind::Image classification (D0004). */
const IMAGE_EXTENSIONS = new Set([
	"png",
	"apng",
	"gif",
	"jpg",
	"jpeg",
	"webp",
	"svg",
	"avif",
	"ico",
	"bmp",
]);

export function isImageExtension(extension: string): boolean {
	return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

/** Whether a target body's ItemName part (after the first `/`) carries an
 * image extension. A body without `/` is a module path — never a resource. */
export function isImageTargetRef(target: string): boolean {
	const slash = target.indexOf("/");
	if (slash < 0) return false;
	const ext = target.slice(slash + 1).match(/\.([a-zA-Z0-9]+)$/)?.[1];
	return ext !== undefined && isImageExtension(ext);
}

export interface ImageRefHover {
	/** Element to anchor the popover to (the hovered editor DOM node). */
	targetEl: HTMLElement;
	from: number;
	to: number;
	/** Unescaped target body: `name`, `module/name`, `vault::…/name`, … */
	target: string;
}

export interface ImageHoverHooks {
	/** Called once per entry into an image target literal. */
	show(hover: ImageRefHover): void;
}

export function notistImageHover(hooks: ImageHoverHooks): Extension {
	/** Span already handed to the shell; re-fires only after the pointer
	 * leaves image refs (moving within one span stays quiet). */
	let lastFrom = -1;

	return EditorView.domEventHandlers({
		mousemove(event, view) {
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) {
				lastFrom = -1;
				return false;
			}
			const hit = targetLiteralAt(view.state, pos);
			if (!hit || !isImageTargetRef(hit.target)) {
				lastFrom = -1;
				return false;
			}
			if (lastFrom === hit.from) return false;
			lastFrom = hit.from;
			const targetEl =
				event.target instanceof HTMLElement ? event.target : view.contentDOM;
			hooks.show({ targetEl, from: hit.from, to: hit.to, target: hit.target });
			return false;
		},
	});
}
