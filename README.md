# obsidian-notist

Notist World inside Obsidian: borrow Obsidian's GUI shell (workspace, file tree, sync), rebuild all semantics on top of notist.

Design notes and decisions live in the notist repo: `docs/obsidian-notist/README.not` and `docs/ai/2026-08-24 obsidian plugin feasibility research.not`.

## Current state (MVP)

- World switcher: ribbon icon / command / status bar toggles `md` ↔ `notist` world (persisted, body class driven).
- Independent workspaces: each world keeps its own full layout (panes, tabs, sidebars) via `getLayout()`/`changeLayout()` snapshots, saved on switch and on debounced `layout-change`. The Notist explorer simply does not exist in the Markdown world's layout (CSS hiding remains as a guardrail only).
- Ribbon isolation: in the Notist world all ribbon icons are hidden except an allowlist (settings tab, matched by aria-label); the Markdown world is untouched.
- Shared native explorer: both worlds use the built-in file explorer, CSS-filtered to their own file types — all native file ops (context menu, drag, create, delete) work unchanged. "New note" in the Notist world is intercepted and renamed to `.not`. A custom `notist-explorer` view remains available (command only) as the future module-tree placeholder.
- Plain-text `.not` editing via `registerExtensions(["not"], ...)`, with tree-sitter syntax highlighting (tree-sitter-notist grammar running on web-tree-sitter; assets in `assets/`).
- Language server integration (desktop, opt-in in settings): spawns `notist lsp` over stdio for diagnostics, completion, hover and F12 go-to-definition. Server launch is configurable as binary path + full argument list (Zed-style); the server runs with the vault as its working directory — launchers needing their own cwd say so in argv, e.g. dev build: path `nix`, arguments `develop /path/to/notist -c cargo run --manifest-path /path/to/notist/Cargo.toml -- lsp` (or `nix run /path/to/notist -- lsp` for a hermetic rebuild). Failure degrades cleanly to highlighting-only. Requires `notist` installed; see `src/lsp/`.

## Build

```sh
bun install
bun run build
```

Toolchain is bun (dev shell via `direnv allow` / `nix develop`). Registry is pinned to npmmirror in `bunfig.toml`.

Then install into a vault and enable the plugin in Settings → Community plugins:

```sh
bun run sync <vault-path>      # build + copy artifacts (committable, default)
bun run install <vault-path>   # copy only
bun run install --link <vault> # symlink the repo instead, for live dev
```

Default is copy mode (only `manifest.json` / `main.js` / `styles.css`), so the vault stays self-contained and the plugin can be committed with it. Use `--link` on your dev machine so rebuilds take effect without re-installing. The script is idempotent; `--link` refuses to overwrite a real directory.
