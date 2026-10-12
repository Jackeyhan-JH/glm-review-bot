## 🤖 GLM Code Review

Solid change overall; issues concentrate on error handling.

| Severity | Count |
| --- | --- |
| 🟠 major | 1 |
| 🟡 minor | 1 |
| ⚪ nit | 1 |

### Issues not anchored to diff lines

The following 1 finding(s) could not be anchored to a commentable diff line:

- `src/legacy.ts:99` **[minor] Stale code** — Line no longer exists on the new side.

Omitted 1 lower-severity finding(s) below the severity threshold.

---

🤖 commit `9f2b1c3` · model `glm-5.3-flash` · 1 chunk(s) · 1m23s

<!-- glm-review-bot:sha=9f2b1c3a4d5e6f708192a3b4c5d6e7f8091a2b3c -->

----- 行内评论 1/2 · src/calc.ts:12 -----

**[major] Missing null check**

a can be null; accessing a.total crashes.

```suggestion
const total = (a ?? {}).total;
```

<sub>🤖 glm-review-bot · glm-5.3-flash</sub>

----- 行内评论 2/2 · src/util.ts:5 -----

**[nit] Inconsistent naming**

Use camelCase here.

<sub>🤖 glm-review-bot · glm-5.3-flash</sub>
