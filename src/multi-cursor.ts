/**
 * Alt-click multi-selection (VS Code style), pure CM: alt+click adds a
 * cursor, alt+drag adds another selected region, alt+shift+drag selects a
 * rectangle on top of the existing ranges, and alt+double-click adds the
 * clicked word. Escape collapses back to a single cursor (defaultKeymap's
 * simplifySelection). Ctrl/Cmd-click stays reserved for following
 * references (ref-jump.ts), so alt replaces the platform-default
 * ctrl/cmd-click cursor here.
 */
import { type Extension } from "@codemirror/state";
import { EditorView, rectangularSelection } from "@codemirror/view";

export function notistMultiCursor(): Extension {
	return [
		// Routes alt clicks/drag into basicMouseSelection's `multiple` branch
		// (addRange instead of replacing the selection). Requires
		// allowMultipleSelections (enabled in notist-view for vim).
		EditorView.clickAddsSelectionRange.of(
			(event) => event.altKey && event.button === 0,
		),
		// Platform defaults turn alt+drag on macOS into a content drag
		// (drag-copy); keep the pointer selecting whenever alt is held.
		// Non-mac default (!ctrl) is unchanged.
		EditorView.dragMovesSelection.of(
			(event) => event.altKey || !event.ctrlKey,
		),
		// Column select on alt+shift+drag. Not CM's default filter (plain
		// alt), which would swallow the alt+click gesture above.
		rectangularSelection({
			eventFilter: (event) =>
				event.altKey && event.shiftKey && event.button === 0,
		}),
	];
}
