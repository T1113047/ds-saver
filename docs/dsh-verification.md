# DSH 实机验证记录（2026-11-26）

验证目标：把 `ds-saver` 装到一个**全新的 DSH profile** 上，确认 `cordis.patch.yml` 能挂载插件行、模块能导入、四个工具能被模型实际调用。

## 环境

| 项 | 值 |
|---|---|
| DSH 版本 | `0.2.2-rc.5`（Desktop `2.0.24-next` 内置 CLI） |
| 启动方式 | `ELECTRON_RUN_AS_NODE=1` 运行 `app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| DSH_HOME | 临时目录（不污染真实 `~/.dsh`），从空目录开始 |
| Profile | `headless-fresh`，由 `--from-default-profile headless` 初始化 |
| pnpm | `11.28.5`（指向 Desktop 内置 pnpm，仅用于 `dsh plugin add`） |
| 宿主 | Windows 11 / Node 24 |
| 模型 | `qwen3.8-flash`（本机已有 Qwen Token Plan 凭据；DeepSeek key 401、account provider 需重新登录，均与插件无关） |

## 步骤与结果

### 1. 初始化全新 profile

```sh
dsh --profile headless-fresh --from-default-profile headless --dump-config
```

退出码 0，profile 目录自动生成（`package.json` + `cordis.patch.yml` + `cordis.yml`），bundles 为 `dsh-base` + `dsh-headless`。

### 2. 官方插件安装

```sh
dsh plugin --profile headless-fresh add <ds-saver 目录>
```

退出码 0，输出：

```text
dependencies:
+ ds-saver 0.2.0 <- ..\..\..\..\ds-saver-repo
[WARN] The package ds-saver ... linked ... peerDependencies ...
  - @deepseek-ai/dsh-tools@0.2.2-rc.5, @deepseek-ai/cordis@~4.1.0
The linked in dependency will not resolve the peer dependencies from the target node_modules.
```

这条警告就是首版 DSH 适配层的真正问题：`dsh/index.js` 里的 `import { defineTool } from '@deepseek-ai/dsh-tools'` 在全新环境必然失败。

### 3. 发现并修复导入失败

修复前，`--dump-config-schema` 退出码 1：

```text
dsh: error: [/101] Cannot find package '@deepseek-ai/dsh-tools'
  imported from ...\ds-saver-repo\dsh\index.js
```

修复：`dsh/index.js` 不再 import 任何 `@deepseek-ai/*`，内置 `defineDshTool`：

- 参数 DSL（`string` / `number` / `integer` / `boolean` / `array` / `object` / `oneOf` / `json`）编译成原始 JSON Schema；
- `required: true` 收集为根 `required` 数组；
- `execute` 前校验类型、必填、`enum` / `const`；
- 输出 `{ name, description, parameters, output: { schema, render }, execute }`，直接交给 `ctx.tools.register`。

这与 `@deepseek-ai/dsh-tools` 的 `defineTool` 在 schema 投影和参数校验上的行为一致，但没有任何 DSH 包依赖。

### 4. 重新导入

```sh
dsh --profile headless-fresh --dump-config-schema
```

退出码 0；`ds-saver` 行状态为 `absent`（没有 `Config` schema），说明模块已被成功 import。

`--dump-config` 中的行：

```yaml
# == ds-saver
- id: ds-saver
  name: ds-saver/dsh
```

### 5. 真实会话调用工具

`dsh --profile headless-fresh "<prompt>"`，每个工具一次会话：

| 工具 | Prompt 要点 | 结果 |
|---|---|---|
| `tree` | 列当前目录 depth=2 | 输出 `TREE_OK` + 目录树前三行 |
| `rag` | 检索 `export const core` | 输出 `RAG_OK` |
| `handoff` | `next=DSH 实测通过`，写盘 | 输出 `HANDOFF_OK` + `.handoff/handoff-20261126-235601-dsh-实测通过.md`（301 B） |
| `misc` | 一句话总结材料（自定义便宜 provider） | 输出 `MISC_OK` + 模型结论 |

`misc` 使用临时配置把 `qwen-tp` 指向 `https://maas.qianwenaiapi.com/compatible-mode/v1`，`apiKeyEnv=QWEN_TOKEN_PLAN_API_KEY`；说明「换 baseURL + model + key」的自定义 provider 链路在 DSH 上同样可用。

### 6. 0.3.0：rag filter 实测

同一 profile 的 linked 代码更新后（无需重装），再跑一次：

```text
rag(query="RAG_FILTER_MAX_CANDIDATES", path=".", topK=10, filter=true, filter_topK=3)
```

模型返回 `RAG_FILTER_OK`，工具内容为两条 `index.js:行号 — 摘要（理由）`，末尾 `picked 2 / candidates 2`。说明 DSH 适配层新增的 `filter` / `filter_topK` / `model` 参数、便宜模型 JSON 筛选、候选路径/行号校验都正常。

### 7. 0.4.0：tarball、一键包与 ctx 工具

2026-11-27 用第三个全新 `DSH_HOME` / profile 复测 `ds-saver-0.4.0.tgz`：

- `dsh plugin add ds-saver-0.4.0.tgz` → `+ ds-saver 0.4.0`
- `--dump-config` → `- id: ds-saver / name: ds-saver/dsh`
- `--dump-config-schema` → 退出码 0
- `tree` → `TREE_OK`；`rag(filter=true)` → `picked 2 / candidates 3`；`handoff` → 落盘；`misc` → `MISC_OK`

`bundle/install.sh` 在临时 workspace / prefix / data 下实测（Git Bash，Windows 原生路径）：

- 装上 shim + `pkg/` 运行副本、3 个 skills、6 个工具、示例配置；
- 把安装出的 `pkg/` 直接 `dsh plugin add` 到新 profile 也成功；
- 用安装副本跑 `ctx_status`：`context 330,824 / 31.55% / level 提醒`；`ctx_forecast` 正常返回 JSON；
- 修复：最初 shim 写成 `/c/...`，Windows Node 报 `Cannot find module 'C:\c\...'`；改为 `file:///C:/...` 后 `SHIM_OK`。

## 结论

- 全新 DSH profile 上，官方 `dsh plugin add` → `cordis.patch.yml` → `ds-saver/dsh` → `ctx.tools.register` 全链路可用。
- 唯一阻塞点是 DSH 包解析，已用零依赖实现消除；这比要求用户 `pnpm add @deepseek-ai/dsh-tools` 更可靠，也避免把 DSH 内部实现钉进第三方插件。
- 尚未在 DSH Desktop GUI 的 **插件** 页面做视觉验收（无浏览器控制）；本记录只覆盖 CLI/宿主侧安装与工具执行。

## 复现脚本（PowerShell 摘要）

```powershell
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-home'
$env:ELECTRON_RUN_AS_NODE = '1'
$dsh = Join-Path $env:DSH_INSTALL_DIR 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$exe = '<DSH executable>'
$plugin = '<ds-saver checkout>'

Start-Process $exe -ArgumentList "`"$dsh`" --profile headless-fresh --from-default-profile headless --dump-config" -Wait
Start-Process $exe -ArgumentList "`"$dsh`" plugin --profile headless-fresh add $plugin" -Wait
Start-Process $exe -ArgumentList "`"$dsh`" --profile headless-fresh --dump-config-schema" -Wait
Start-Process $exe -ArgumentList "`"$dsh`" --profile headless-fresh `"调用 tree 工具...`"" -WorkingDirectory $plugin -Wait
```
