# test/diff/fixtures

全部夹具取自真实 `git diff` 输出（git 2.x，`core.quotepath` 默认开、
`diff.renames` 默认开），生成步骤：临时仓库里按序提交，用
`git diff HEAD~1 HEAD` 截取对应一步的 diff（`user.name`/`user.email` 已在
仓库本地配置，输出与贡献者无关）。

| 夹具 | 内容 | 验证点 |
|---|---|---|
| `added.diff` | 新增 `src/parse.ts` | `new file mode`、`--- /dev/null`、`@@ -0,0 +1,4 @@` |
| `modified.diff` | 修改 `src/calc.ts`（含中文与空行） | 单 hunk、空上下文行（单个空格）、C 语言风格无需处理 |
| `deleted.diff` | 删除 `doomed.txt` | `deleted file mode`、`+++ /dev/null`、末尾 `\ No newline` |
| `renamed.diff` | `ten.txt` → `ten-renamed.txt` | `similarity index 100%`、`rename from/to`、无 hunk |
| `renamed-modified.diff` | 重命名 + 修改（相似度 72%） | `rename from/to` + 两个 hunk |
| `binary.diff` | 修改 `logo.bin`（含 NUL 字节） | `Binary files … differ`、无 `---`/`+++`、无 hunk |
| `no-newline.diff` | 改末行，新旧两侧都无结尾换行 | `-` 与 `+` 后各有一条 `\ No newline at end of file` |
| `spaces.diff` | 修改 `my lib/util helpers.ts` | 文件名含空格；git 给 `---`/`+++` 行补行尾 TAB |
| `multi-hunk.diff` | `grid.txt` 两处相距很远的修改 | 多 hunk、行号区间不连续 |
| `crlf.diff` | CRLF 文件改中间一行 | 正文行行尾 `\r`（头部行没有） |
| `quoted-path.diff` | 修改 `src/组件.ts` | `core.quotepath` 的八进制 UTF-8 转义与引号 |
| `rename-spaces.diff` | `docs/old name with space.md` 重命名 | `rename from/to` 行内含空格的裸路径 |
| `combined.diff` | 一次提交里改 4 个文件 | 多文件顺序、混合状态（含空上下文行） |

复现方式（节选）：

```bash
git init demo && cd demo
git config user.email t@e.c && git config user.name t && git config core.autocrlf false
printf 'keep1\nkeep2\nold last line' > tail.txt && git add -A && git commit -qm base
printf 'keep1\nkeep2\nnew last line' > tail.txt && git add -A && git commit -qm step
git diff HEAD~1 HEAD   # → no-newline.diff
```
