# obsidian-notist

Notist World inside Obsidian: borrow Obsidian's GUI shell (workspace, file tree, sync), rebuild all semantics on top of notist.

Design notes and decisions live in the notist repo: `docs/obsidian-notist/README.not` and `docs/ai/2026-08-24 obsidian plugin feasibility research.not`.

## Current state (MVP)

- World switcher: ribbon icon / command / status bar toggles `md` ↔ `notist` world (persisted, body class driven).
- Independent workspaces: each world keeps its own full layout (panes, tabs, sidebars) via `getLayout()`/`changeLayout()` snapshots, saved on switch and on debounced `layout-change`. The Notist explorer simply does not exist in the Markdown world's layout (CSS hiding remains as a guardrail only).
- Ribbon isolation: in the Notist world all ribbon icons are hidden except an allowlist (settings tab, matched by aria-label); the Markdown world is untouched.
- Shared native explorer: both worlds use the built-in file explorer, CSS-filtered to their own file types — all native file ops (context menu, drag, create, delete) work unchanged. "New note" in the Notist world is intercepted and renamed to `.not`. Diagnostic pills decorate it in both worlds.
- Notist explorer (command only): a real Zed/VSCode-style file tree for the Notist world — folders expand/collapse (state persists through world switches and reloads), inline rename, context menus (new `.not` file / folder, delete to trash, reveal in system explorer), full keyboard navigation (arrows/Enter/F2/Delete), drag & drop moves, and aggregated LSP diagnostic pills on every row with click-through to the first problem. Markdown files are filtered out; extensions are always shown. Path: `src/explorer-view.ts`; it is the Notist world's default left-sidebar tab (auto-opened on load and on world switch, also via the "Open Notist explorer" command).
- Plain-text `.not` editing via `registerExtensions(["not"], ...)`, with tree-sitter syntax highlighting (tree-sitter-notist grammar running on web-tree-sitter; assets in `assets/`).
- Language server integration (desktop, opt-in in settings): spawns `notist lsp` over stdio for diagnostics, completion, hover and F12 go-to-definition. The "notist command" setting holds how to invoke the notist CLI — the plugin appends the subcommand itself (`lsp` today, `build` etc. later), so one command backs all integrations; "notist extra arguments" is appended after the subcommand (e.g. `--no-daemon` to embed the service instead of the shared per-vault daemon). Whitespace-separated; quote parts containing spaces; not a shell (`~`, `$VAR`, globs stay literal). A `--` before the subcommand is inserted automatically for wrapper launchers (`nix`, `cargo`, `npm`, …) unless the command already contains one. The server runs with the vault as its working directory — launchers needing their own cwd say so in the command, e.g. dev build: `nix develop /path/to/notist -c cargo run --manifest-path /path/to/notist/Cargo.toml` (or `nix run /path/to/notist` for a hermetic rebuild). Failure degrades cleanly to highlighting-only. Requires `notist` installed; see `src/lsp/`.

## Build

```sh
bun install
bun run build
```

Toolchain is bun (dev shell via `direnv allow` / `nix develop`). Registry is pinned to npmmirror in `bunfig.toml`.

Then install into a vault and enable the plugin in Settings → Community plugins:

```sh
bun run sync <vault-path>      # build + copy artifacts (committable, default)
bun run sync --link <vault>    # symlink the repo instead, for live dev
bun run scripts/install.ts <vault-path>   # copy only (skip rebuild)
```

Works for first-time installs too — the vault doesn't need the plugin beforehand. Default is copy mode (only `manifest.json` / `main.js` / `styles.css`), so the vault stays self-contained and the plugin can be committed with it. Use `--link` on your dev machine so rebuilds take effect without re-installing. The script is idempotent; `--link` refuses to overwrite a real directory.
