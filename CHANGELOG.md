# Changelog

## 0.4.0

- 新增一键安装包 `bundle/`：一条命令装 OpenCode 插件 shim、三个通用版 skills、
  计量/索引工具（`ctx-usage.py`、`index-rebuild.py`、`rag-emb-sync.py`、`rag-refresh.sh`）、
  RAG 配置模板与 `rag-refresh` 包装器；覆盖前自动备份，不读写密钥。
- `ctx_status` 不再依赖工作区里的 `ctx-usage.py`：按 `DS_SAVER_CTX_USAGE` → 包内
  `bundle/tools/` → `~/.local/share/opencode/ds-saver/tools/` → 旧工作区路径 依次查找；
  缺脚本时返回可操作提示而不是 `spawn ENOENT`。
- 所有 Python 调用改为 `python3` 优先、`python` 回退（`DS_SAVER_PYTHON` 可覆盖）。
- `ctx_forecast` / `ctx_calibrate` / `ctx_report` / `ctx-usage.py` 支持
  `DS_SAVER_OPENCODE_DB` 与 `--db`；数据库不存在时给出明确提示。
- `index-rebuild.py` / `rag-emb-sync.py` / `rag-refresh.sh` 支持 `DS_SAVER_WORKSPACE`
  等环境变量，去掉硬编码路径，可在任意工作区使用。
- 修正缓存成本口径：500K / 650K 按 0.02 元/百万为 0.010 / 0.013 元。
- DSH 的 `misc` 参数说明改为与实现一致：无 `paths` 时仍可跑只读循环，只能读模型点名的文件。

## 0.3.0

- `rag` 新增可选 `filter` 模式：先检索候选（最多 12 条，命中行前后各 2 行、约 800 字符/条），
  再由便宜模型输出 JSON 筛选结果，校验路径/行号必须落在候选集合内，只注入 3–5 条
  `文件:行号 — 摘要（理由）`，附 `picked N / candidates M`。
- `rag` 新增 `filter_topK`（1–8，默认 5）与 `model`。
- 筛选失败（无 key、HTTP 错误、JSON 非法、空结果）自动回退原始命中，metadata 标记
  `filter_fallback: true` 与 `filter_error`，不抛错、不中断主流程。
- 材料发送前过 `assertNoSecrets`，候选路径必须在 root 内且通过敏感路径检查。
- `filter: true` 强制使用内置检索。
- DSH 适配层的 `rag` 参数同步增加三个字段。

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
- 去掉写死的工作区路径，默认使用进程 cwd。
- 增加 MIT LICENSE、GitHub Actions CI、CONTRIBUTING、CHANGELOG。
- 工具名保持不变：`misc`、`ctx_status`、`ctx_forecast`、`ctx_calibrate`、`ctx_report`、`handoff`。

## 0.1.0

- 初始原型：`misc`、`ctx_status`、`ctx_forecast`、`ctx_calibrate`、`ctx_report`、`handoff`。
- DeepSeek 长会话实测数据与预测/校准协议。
