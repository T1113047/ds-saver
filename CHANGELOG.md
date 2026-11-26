# Changelog

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
