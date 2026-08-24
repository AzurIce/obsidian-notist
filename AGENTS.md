# AGENTS.md

## NOTIST_PATH 环境变量

`NOTIST_PATH` 指向 notist 代码所在目录（在本机通过项目根目录的 `.env` 定义，
如 `NOTIST_PATH=~/Files/notist`）。注意本 agent 的 shell 每次调用都是全新环境，
不会自动加载 `.env`/direnv，使用前请先确认：

```bash
echo "$NOTIST_PATH"   # 为空时可用 set -a; . ./.env; set +a 加载
```

**当 `NOTIST_PATH` 未设置时，提醒用户进行设置，不要自行猜测路径。**

## 文档位置约定

`$NOTIST_PATH/docs/` 下包含 notist 及相关项目的**全部文档**，本项目的文档位于
`$NOTIST_PATH/docs/obsidian-notist/`。

- 整理文档、修改文档等操作都必须在 `$NOTIST_PATH/docs/` 下的对应目录进行，
  不要在本仓库内新建文档。
- 操作前阅读并遵守 `$NOTIST_PATH/AGENTS.md` 和 `$NOTIST_PATH/docs/AGENTS.md`
  的约定，要点：
  - 文档一律使用 `.not` 格式，不要出现 `.md`；
  - 整理文档放到 `docs/ai/` 下，以 `yyyy-mm-dd xxx` 命名，并在
    `docs/ai/README.not` 中引用并附简短摘要；
  - `type=user` 的内容属于用户本人，除非明确要求不得增删改。
