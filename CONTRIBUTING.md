# Contributing

## 开发

```sh
git clone <repo>
cd ds-saver
npm run check
npm test
```

要求 Node.js 20+，无第三方依赖。

本机安装（OpenCode）：

```sh
./install.sh
```

脚本只在 `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/ds-saver/index.js` 建一个 re-export shim，不改其它配置。

## 测试

- `npm run check`：语法检查。
- `npm test`：离线 smoke 测试，使用假 fetch，不需要任何 API Key。
- 新增工具时，在 `test/smoke.mjs` 加至少一个正向断言和一个安全边界断言（敏感路径、越界、截断）。

## 代码约定

- ESM，只依赖 `node:` 内建模块和全局 `fetch`。
- 不新增运行时依赖；需要外部能力时用可配置命令 + 安全回退。
- 任何读文件/遍历/外部命令都必须过 `assertSafePath` / `assertNoSecrets`。
- 日志、错误信息、测试输出不得包含 API Key 或文件正文。

## 提交

- 一个 PR 只做一件事。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀。
- 涉及工具参数变化时同步更新 README 工具表。

## 发布

1. 更新 `package.json` 版本与 `CHANGELOG.md`。
2. `npm test` 全绿。
3. `npm publish`（需要 npm 账号与 2FA）。
4. 打 tag：`git tag vX.Y.Z && git push --tags`。
