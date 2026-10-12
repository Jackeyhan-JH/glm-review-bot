# 状态页截图（#14 验收标准第 4 条）

在 box 上用演示数据启动状态页后截取，贴在 PR 描述里：

```bash
node test/status/demo.ts 43140     # 只监听 127.0.0.1，Ctrl+C 退出
# 浅色（跟随系统 / ?theme=light）与深色（?theme=dark）各截一张
```

- `status-page-light.png`：浅色主题
- `status-page-dark.png`：深色主题

演示数据来自 `test/status/helpers.ts` 的 `seedDemoState`（与快照测试同一份种子），
不碰真实 `gh` / `claude`。
