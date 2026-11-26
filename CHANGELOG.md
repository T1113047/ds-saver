# Changelog

## 0.2.1

- **DSH 端实机修复**：`dsh/index.js` 不再 `import '@deepseek-ai/dsh-tools'`。第三方插件以 `link:` / 本地目录 / npm 注入时 Node 无法从 DSH 安装目录解析该 peer，实测报 `Cannot find package '@deepseek-ai/dsh-tools'`；改为内置等价 `defineDshTool`（参数 DSL → 原始 JSON Schema + 参数校验）。
- 移除未使用的 `@deepseek-ai/*` peerDependencies；`engines.dsh` 继续约束 `>=0.2.2-rc.5 <0.3.0-0`。
- 在全新 DSH `0.2.2-rc.5` headless profile 上完成 `tree` / `rag` / `misc` / `handoff` 四工具实测，记录见 `docs/dsh-verification.md`。
- 修复 Windows 下 `test/smoke.mjs` 的 agent 读文件用例：用 `JSON.stringify` 构造 JSON，避免路径反斜杠被当成非法转义（此前只在 Linux/macOS 通过）。
- README 更新 DSH 安装方式、实测状态和已知限制。

## 0.2.0

- 项目改名 `ctx-memory` → `ds-saver`（中文名：DS节约插件）。
- 新增 `tree` 工具：紧凑目录树，默认忽略 `.git`、`node_modules`、构建产物；带敏感路径与截断保护。
- 新增 `rag` 工具：轻量本地检索，支持外部检索命令，未配置时回退到内置行匹配。
- 配置与数据目录改为 `ds-saver`，同时兼容旧 `ctx-memory` 配置、环境变量与数据目录。
- 去掉写死的 `/root/code/opencode` 工作区路径，默认使用进程 cwd。
- 增加 MIT LICENSE、GitHub Actions CI、CONTRIBUTING、CHANGELOG。
- 工具名保持不变：`misc`、`ctx_status`、`ctx_forecast`、`ctx_calibrate`、`ctx_report`、`handoff`。

## 0.1.0

- 初始原型：`misc`、`ctx_status`、`ctx_forecast`、`ctx_calibrate`、`ctx_report`、`handoff`。
- DeepSeek 长会话实测数据与预测/校准协议。
