## 关联 issue

Closes #<issue 编号>

## 改动说明

<!-- 简述做了什么、为什么这么做；复杂设计点可链接到 issue 评论 -->

## 检查清单

- [ ] 只改了对应 issue「允许改动的文件范围」内的文件
- [ ] 未改 `package.json` / `package-lock.json` / 共享文件（`src/lib/**`、`src/cli.ts`、`.github/**` 等，除非本 issue 就是地基 #2）
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过，测试未使用真实网络 / 真实 `gh` / 真实 `claude`（一律使用 `test/helpers/fakebin.ts` 或依赖注入）
- [ ] 界面与文案为中文（技术名词除外）
- [ ] 按下方逐条对照本 issue 的验收标准

## 验收标准逐条对照

| 验收标准 | 如何满足（测试文件 / 测试名，或说明为何只能合并后验证） |
|---|---|
| … | … |
