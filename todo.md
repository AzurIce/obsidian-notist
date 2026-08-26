# 存在的问题

- [x] Notist World 下的入链、出链、标签、笔记属性、大纲、Excalidraw 侧边面板都还是和 Markdown World 一样。应该先全部隐藏，等后续接入 Notist 后或许可以做一些内部实现的替换。（已隐藏 + 大纲/入链/出链已替换为 Notist 语义面板，2026-08-27）

# 待办

- [ ] 标签、属性、图谱面板仍是长期隐藏状态，等待 notist 侧补齐 LSP 查询面（tags/attributes query）后另行设计替换。
- [ ] 诊断 version 门控、session generation、多 leaf 文本 hash 匹配（见 notist docs/ai/2026-08-26 obsidian-notist lsp diagnostics design 的阶段一清单）。
- [ ] 大纲折叠状态在文档切换后保留（当前 session 内共享一套 collapsed set）；符号面板 MRU 空态与完整键盘选择。
- [ ] 标准 textDocument/documentLink（出链内联跳转）尚未实现，目前出链面板走 notist/documentReferences 扩展。
- [ ] server code action（quick fix）等待上游声明 capability 后再接 UI。
