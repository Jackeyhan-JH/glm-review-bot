## 🤖 GLM 代码审查

整体结构清晰，分账逻辑正确；问题集中在错误处理。

| 严重度 | 数量 |
| --- | --- |
| 🟠 重要 | 1 |
| 🟡 一般 | 1 |

### 未纳入审查的文件

- `package-lock.json` — 命中忽略规则
- `assets/logo.png` — 二进制文件

### 审查范围截断

- `src/generated.ts` — 块数超过上限（maxChunks=4），仅包含 1/3 段

### ⚠️ 仓库配置有误

`.glm-review.yml` 存在以下问题，本次已按默认配置审查：

- .glm-review.yml: ignore 第 1 项应为字符串，实际是 42

---

🤖 commit `9f2b1c3` · 模型 `glm-5.3` · 分块 2 · 耗时 45.0s

<!-- glm-review-bot:sha=9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c -->

----- 行内评论 1/2 · `src/calc.ts:12` -----

**[重要] 空指针未判断**

a 可能为 null，直接取属性会崩溃。

```suggestion
const total = (a ?? {}).total;
```

<sub>🤖 glm-review-bot · glm-5.3</sub>

----- 行内评论 2/2 · `src/parse.ts:18-22` -----

**[一般] 建议抽成函数**

这五行与 parseAmount 重复，抽出来便于测试。

建议改为：

```
function parseRange(text) {
  return text.split("-").map(Number);
}
```

<sub>🤖 glm-review-bot · glm-5.3</sub>
