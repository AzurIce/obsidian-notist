/**
 * Ctrl/Cmd-click to follow a `#<...>` target literal (the notist reference
 * sugar). Pure CM — target resolution and navigation live in the shell hook
 * (notist-view.ts), per the shell/semantics layering discipline.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { targetLiteralAt } from "./highlight";

export interface RefJumpHooks {
	/** The target body (unescaped `ModulePath[/ItemName]`) and the CM
	 * position under the pointer (for position-based definition). */
	follow(target: string, pos: number): void;
}

export function notistRefJump(hooks: RefJumpHooks): Extension {
	return EditorView.domEventHandlers({
		mousedown(event, view) {
			if (!(event.ctrlKey || event.metaKey)) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return false;
			const hit = targetLiteralAt(view.state, pos);
			if (!hit) return false;
			// Keep CM from moving the caret; the jump replaces the click.
			event.preventDefault();
			hooks.follow(hit.target, pos);
			return true;
		},
	});
}
