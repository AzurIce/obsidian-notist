/**
 * Ctrl/Cmd-click to follow a `#<...>` target literal (the notist reference
 * sugar), with an underline affordance while ctrl/meta-hovering one. Pure
 * CM — target resolution and navigation live in the shell hook
 * (notist-view.ts), per the shell/semantics layering discipline.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	type DecorationSet,
} from "@codemirror/view";
import { targetLiteralAt } from "./highlight";

export interface RefJumpHooks {
	/** The target body (unescaped `ModulePath[/ItemName]`) and the CM
	 * position under the pointer (for position-based definition). */
	follow(target: string, pos: number): void;
}

/** Underline range for the ctrl-hovered reference; null = none. */
const setCtrlHoverRef = StateEffect.define<{ from: number; to: number } | null>();

const ctrlHoverField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (!effect.is(setCtrlHoverRef)) continue;
			if (effect.value === null) return Decoration.none;
			const { from, to } = effect.value;
			return Decoration.set(
				[Decoration.mark({ class: "cm-notist-ref-jump" }).range(from, to)],
				true,
			);
		}
		// Hover state is ephemeral: a doc edit invalidates the range.
		if (tr.docChanged) return Decoration.none;
		return value.map(tr.changes);
	},
	provide: (f) => EditorView.decorations.from(f),
});

export function notistRefJump(hooks: RefJumpHooks): Extension {
	/** Last known pointer position, so pressing ctrl over a reference
	 * (without moving) still shows the underline. */
	let lastCoords: { x: number; y: number } | null = null;
	/** `from:to:held` of the last dispatched state; skips no-op dispatches
	 * (mousemove fires per pixel). */
	let lastKey = "";

	const update = (view: EditorView, coords: { x: number; y: number } | null, held: boolean) => {
		lastCoords = coords;
		const pos = coords ? view.posAtCoords(coords) : null;
		const hit = pos === null ? null : targetLiteralAt(view.state, pos);
		const active = held && hit !== null;
		const key = active ? `${hit!.from}:${hit!.to}:1` : "";
		if (key === lastKey) return;
		lastKey = key;
		view.dispatch({
			effects: setCtrlHoverRef.of(active ? { from: hit!.from, to: hit!.to } : null),
		});
	};

	return [
		ctrlHoverField,
		EditorView.domEventHandlers({
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
			mousemove(event, view) {
				update(view, { x: event.clientX, y: event.clientY }, event.ctrlKey || event.metaKey);
				return false;
			},
			// Re-evaluate when the modifier toggles without pointer movement.
			keydown(event, view) {
				if (event.key !== "Control" && event.key !== "Meta") return false;
				update(view, lastCoords, event.ctrlKey || event.metaKey);
				return false;
			},
			keyup(event, view) {
				if (event.key !== "Control" && event.key !== "Meta") return false;
				update(view, lastCoords, event.ctrlKey || event.metaKey);
				return false;
			},
			mouseleave(_event, view) {
				update(view, null, false);
				return false;
			},
			blur(_event, view) {
				update(view, lastCoords, false);
				return false;
			},
		}),
	];
}
