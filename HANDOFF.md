# ds-saver 交接报告

> 日期：2026-11-26  
> 项目：DS节约插件（npm / GitHub 名：`ds-saver`）  
> 目标：在 OpenCode 与 DeepSeek Harness (DSH) 双端提供上下文/成本节约能力。

## 1. 一句话状态

OpenCode 端已完成并实测（8 个工具、9 组 smoke 断言、qwen 真实调用通过）；DSH 适配层代码已完成但**未在 DSH 实机运行**；GitHub 仓库已上线，npm 包尚未发布（卡在 npm 2FA）。

- GitHub：<https://github.com/T1113047/ds-saver>
- npm：`ds-saver@0.2.0`，未发布
- CI：`main` 首次提交已通过（GitHub Actions）
- 本地最新提交：`7c69dcd chore: add repository metadata`（待推送）

## 2. 项目结构

```text
ds-saver/
├── index.js                 # OpenCode 插件入口（8 个工具）
├── dsh/index.js             # DSH / Cordis 适配入口（4 个工具）
├── cordis.patch.yml         # DSH bundle 补丁
├── install.sh               # OpenCode shim 安装脚本
├── package.json             # 双端 exports + dsh.bundle.patch
├── test/smoke.mjs           # 离线 smoke 测试（9 组）
├── scripts/                 # 上下文测算脚本（Python）
├── docs/
│   ├── deepseek-context-data.md
│   ├── calibration-protocol.md
│   ├── dsh-adapter.md
│   └── reasoning-effort.md
├── data/                    # 可公开聚合数据
├── .github/workflows/ci.yml # Node 20/22/24
├── LICENSE                  # MIT
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
└── HANDOFF.md               # 本文件
```

## 3. OpenCode 端

### 工具

| 工具 | 作用 | 备注 |
|---|---|---|
| `misc` | 便宜模型筛选工具输出/日志/文档 | 默认 hy4 → mimo → qwen |
| `tree` | 紧凑目录树 | 忽略依赖/构建目录，拒绝敏感路径 |
| `rag` | 轻量本地检索 | 优先 `DS_SAVER_RAG_CMD`，否则内置行匹配 |
| `ctx_status` | 当前会话上下文/缓存/成本 | 依赖本机 `ctx-usage.py` |
| `ctx_forecast` | 预测换窗时机与成本 | 依赖 OpenCode 会话数据 |
| `ctx_calibrate` | 修正预测偏差 | 写 calibration 文档 |
| `ctx_report` | 匿名本地指标 | 不自动上传 |
| `handoff` | 生成交接文档 | 默认写 `.handoff/` |

### 安装

```sh
git clone https://github.com/T1113047/ds-saver.git
cd ds-saver
./install.sh
```

或在 `opencode.json(c)`：

```jsonc
{ "plugins": ["ds-saver"] }
```

### 配置

`~/.config/opencode/ds-saver.json`（600）：

```json
{
  "order": ["hy4", "mimo", "qwen"],
  "timeoutSec": 60,
  "maxOutputTokens": 2048,
  "providers": {
    "hy4":  { "apiKeyEnv": "TOKENHUB_API_KEY" },
    "mimo": { "apiKeyEnv": "MIMO_API_KEY" },
    "qwen": { "apiKeyEnv": "DASHSCOPE_API_KEY" }
  }
}
```

兼容旧名：`ctx-memory.json`、`CTX_MEMORY_*` 环境变量、旧数据目录仍然可用。

### 测试

```sh
npm run check
npm test
```

结果：9 组断言全部通过（含 tree/rag 正向、敏感路径、越界、截断、旧配置兼容）。

### qwen 真实链路验证

用 OpenCode 本机 `alibaba-cn` 凭据，自定义 provider 指向 DashScope：

```json
{
  "order": ["qwen-test"],
  "providers": {
    "qwen-test": {
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3.8-flash",
      "apiKeyEnv": "DS_SAVER_TEST_KEY"
    }
  }
}
```

调用 `misc` 结果：正确从日志中提取 `step3 缺模块 @deepseek-ai/dsh-tools`，usage 265 prompt / 729 completion（reasoning 711）。说明「换 baseURL + 密钥即可接自定义 provider」的链路可用。

## 4. DSH 端

### 结构

DSH 插件不是 `Plugin.define`，而是 Cordis 模块：

```js
export const name = 'ds-saver'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ ... }))
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: ds-saver
      name: 'ds-saver/dsh'
```

### 安装

```sh
dsh plugin --profile web add ds-saver
# 或本地目录
dsh plugin --profile web add /path/to/ds-saver
```

### 能力差异

| 工具 | OpenCode | DSH |
|---|---|---|
| `misc` | ✅ | ✅（不支持 `paths`，材料放 `material`） |
| `tree` | ✅ | ✅ |
| `rag` | ✅ | ✅ |
| `handoff` | ✅ | ✅ |
| `ctx_status` / `ctx_forecast` / `ctx_calibrate` / `ctx_report` | ✅ | ❌ 依赖 OpenCode 会话库 |

### DSH 测试建议

```sh
dsh --profile web --dump-config   # 确认出现 ds-saver 行
dsh --profile web                 # 启动后依次试 tree / rag / misc
```

注意：
- `dump-config` 有行不等于 `apply` 跑过，必须实际调用工具。
- 依赖 `@deepseek-ai/dsh-tools@0.2.2-rc.5`；npm 的 `latest` 标签仍指向旧的 `0.0.1-rc.1`，不要用 `latest`。
- DSH 仍是 developer preview，接口可能破坏性变更。

## 5. 发布状态

### GitHub

- 仓库：<https://github.com/T1113047/ds-saver>（public，MIT）
- 已推送：`ab627a0` + CI 成功
- 待推送：`7c69dcd`（仓库元数据）以及本报告提交

### npm

`ds-saver@0.2.0` 已打包（46.1 kB / 17 files），发布被 npm 拒绝：

```text
403 Two-factor authentication or granular access token with bypass 2fa enabled is required
```

npm 正在限制 bypass 2FA token 直接发布。可行方式：

1. 在本机终端 `cd ds-saver && npm publish --access public`，按提示输入 OTP；
2. 或 `npm publish --otp=123456`（30 秒有效）；
3. 或配置 npm Trusted Publishing（GitHub Actions OIDC），长期最省事。

### DSH Hub / OpenCode 收录

1. DSH Hub：<https://dsh-hub.cc/publish>，GitHub 登录后提交 repo 或 npm 包；服务端检查根 `package.json` 的 `dsh.bundle.patch`。
2. GitHub topics 已加：`dsh-plugin`、`deepseek-harness`、`opencode-plugin`。
3. OpenCode 无官方市场，可向 <https://github.com/awesome-opencode/awesome-opencode> 提 PR，或走 <https://opencode.im/submit>。

## 6. 已知问题与未验证

- **DSH 入口未实机运行**：本机没有 `dsh`，只做了语法检查；`defineTool` 的参数 DSL、`output.render` 需在 DSH 上确认。
- **DSH 的 `misc` 不支持 `paths`**：首版只接受 `material`；要读文件可后续加，但需确认 DSH 的文件访问权限模型。
- **`ctx_status` 路径**：默认跟随 workspace/cwd；若插件启动目录不是 OpenCode 工作区，需要显式 `DS_SAVER_CTX_USAGE`。
- **`rag` 外部命令**：只按空白/引号拆分参数，不经过 shell，不支持管道、重定向、变量展开。
- **旧目录回退**：配置/数据目录的旧路径回退在模块加载时判定一次，运行中新建目录不会热切换。
- **预测精度**：轮次预测 MAE 41–68，区间覆盖约 50%，只作粗估；绝对阈值 300/500/650/800K 仍应优先。

## 7. 安全

- 不要提交 `~/.npmrc`、`~/.config/opencode/ds-saver.json`、`~/.config/opencode/ds-saver.env`。
- 已暴露过的 GitHub PAT / npm token 建议全部撤销并重新生成；npm token 建议保留 CIDR 限制与最短有效期。
- 插件的 `tree` / `rag` / `misc` 会拒绝 `03-密钥`、`.env*`、`auth.json`、私钥等路径；材料命中密钥模式会中止。
- `ctx_report` 只写本地匿名 JSONL，不自动联网。

## 8. 后续 TODO

1. 推送 `7c69dcd` 与本报告。
2. 在你有 DSH 的电脑上：装包 → `dsh --profile web --dump-config` → 实际调用 `tree` / `rag` / `misc`。
3. npm 发布 0.2.0（OTP 或 Trusted Publishing）。
4. 发布后提交 DSH Hub 收录，再考虑 awesome-opencode PR。
5. 给子 agent 配 `#low` 变体（见 `docs/reasoning-effort.md`），先只给检索/整理类 agent，`general` 保持 `high`。
6. 视 DSH 实测结果决定是否需要把 `src/core` 从 `index.js` 进一步拆出。
