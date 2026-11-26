# ds-saver 交接报告

> 更新：2026-11-27  
> 项目：DS节约插件（npm / GitHub 名：`ds-saver`）  
> 目标：在 OpenCode 与 DeepSeek Harness (DSH) 双端提供上下文/成本节约能力。

## 1. 一句话状态

OpenCode 端与 DSH 端都已完成实机验证；`0.4.1` 已推送到 GitHub `main` 并发布到 npm `latest`，但 Windows 打包带入 CRLF 行尾；`0.4.2` 已修 LF 并推送 GitHub，待 npm 发布。

- GitHub：<https://github.com/T1113047/ds-saver>（`main` = 0.4.2）
- npm：`ds-saver@0.4.1` 已发布（`latest`，`bundle/install.sh` 在 Unix 因 CRLF 不可执行，建议 deprecate）；`0.4.2` 待发布
- 第三方库：仓库已有 `dsh-plugin` topic；awesome-deepseek-harness-plugins 已收录（PR #1124），deepseek1024.com 目录已出现 `T1113047/ds-saver`
- 本地 tarball：`ds-saver-0.4.1.tgz`（在仓库根目录，已 gitignore）

## 2. 这次做了什么

1. **DSH 全新 profile 实测**：临时 `DSH_HOME` + `headless-fresh`，官方 `dsh plugin add` 安装；`tree` / `rag` / `misc` / `handoff` 四工具被模型实际调用成功。之后又用 `0.4.0` tarball 在另一个全新 `DSH_HOME` / profile 上复测，四工具与 `rag filter` 均通过。
2. **修掉 DSH 导入阻塞**：`dsh/index.js` 原 `import '@deepseek-ai/dsh-tools'` 在 linked 安装下必然失败（`Cannot find package`）。改为内置 `defineDshTool`（参数 DSL → 原始 JSON Schema + 参数校验），移除 `@deepseek-ai/*` peerDependencies。
3. **0.3.0 `rag filter`**：检索候选（最多 12 条、命中行前后 2 行、约 800 字符/条）→ 便宜模型输出 JSON 选择 → 校验路径/行号必须落在候选内 → 只注入 3–5 条 `文件:行号 — 摘要（理由）`，附 `picked N / candidates M`；失败自动回退原始命中。
4. **Windows 测试回归**：smoke 测试里用模板字符串拼 JSON 导致路径反斜杠非法转义，改为 `JSON.stringify`。
5. **文档/文章**：`docs/dsh-verification.md`、`docs/dsh-adapter.md`、`docs/article-dsh-fresh-install.md`。
6. **0.4.0 一键包**：`bundle/install.sh` 实测装上插件 shim、`pkg/` 运行副本、3 个 skills、6 个工具、示例配置；`pkg/` 可直接 `dsh plugin add`。`ctx_status` / `ctx_forecast` 用安装副本跑通真实 OpenCode 会话。
7. **Windows shim 修复**：Git Bash 下最初生成 `/c/...` 路径，Windows Node 报 `Cannot find module 'C:\c\...'`；改为 `file:///C:/...` 并归一化 `--prefix C:\...` 后，Node 可直接加载。
8. **0.4.2 行尾修复**：0.4.0 / 0.4.1 的 npm 包为 CRLF，`bundle/install.sh` 在 Linux/macOS 报 `set: pipefail: invalid option name`；0.4.2 统一 LF，并加 `.gitattributes` + `test/lf.mjs` 防回归。

## 3. 项目结构

```text
ds-saver/
├── index.js                 # OpenCode 入口（8 个工具）
├── dsh/index.js             # DSH / Cordis 入口（4 个工具，零 @deepseek-ai 依赖）
├── cordis.patch.yml         # DSH bundle 补丁
├── install.sh               # OpenCode shim 安装脚本
├── package.json             # 双端 exports + dsh.bundle.patch，engines.dsh
├── test/smoke.mjs           # 离线 smoke（12 组）
├── scripts/                 # 上下文测算脚本（Python）
├── docs/
│   ├── deepseek-context-data.md
│   ├── calibration-protocol.md
│   ├── dsh-adapter.md
│   ├── dsh-verification.md
│   ├── article-dsh-fresh-install.md
│   └── reasoning-effort.md
├── data/                    # 可公开聚合数据
├── .github/workflows/ci.yml # Node 20/22/24
└── README.md / CHANGELOG.md / HANDOFF.md
```

## 4. 双端能力

| 工具 | OpenCode | DSH | 说明 |
|---|---|---|---|
| `misc` | ✅ | ✅ | DSH 版不支持 `paths`，材料放 `material`；需要便宜模型配置 |
| `tree` | ✅ | ✅ | 纯本地，无密钥 |
| `rag` | ✅ | ✅ | 含 0.3.0 `filter`；纯本地 + 可选便宜模型 |
| `handoff` | ✅ | ✅ | 写 markdown，无密钥 |
| `ctx_status` / `ctx_forecast` / `ctx_calibrate` / `ctx_report` | ✅ | ❌ | 依赖 OpenCode 会话库 |

## 5. 验证与测试

```sh
npm run check   # 3 个文件语法检查
npm test        # smoke: 12 组断言全部通过（Windows / Node 24 实测）
```

DSH 实测细节见 `docs/dsh-verification.md`。关键结果：

- `--dump-config` 出现 `- id: ds-saver / name: ds-saver/dsh`
- `--dump-config-schema` 退出码 0（模块导入成功）
- 四个工具各跑一次真实 headless 会话，均成功
- `rag(filter=true)` 返回 `picked 2 / candidates 2`

## 6. 发布状态

### GitHub

已推送 `efda262`（DSH 修复）、`a440ab2`（验证+文章）、`2412984`（rag filter 0.3.0）。

### npm

`npm publish` 当前返回：

```text
403 Your account has been temporarily suspended due to a recent security-sensitive action.
```

背景：npm 在开启 2FA 后触发账号级临时安全暂停（与包内容无关）。恢复后二选一：

1. 用 OTP 发布：`npm publish --access public --otp=<6位>`；
2. 创建 granular access token（publish + bypass 2FA）后 `NPM_TOKEN=... npm publish --access public`。

发布后立刻验证：`npm view ds-saver version` → `0.3.0`。

### DSH Hub / 第三方库

1. 仓库已有 topics：`dsh-plugin`、`deepseek-harness`、`opencode-plugin`；Hub 会按 `dsh-plugin` 自动同步。
2. 也可在恢复后到 <https://dsh-hub.cc/publish> 用 GitHub 登录提交 repo 或 npm 包；服务端检查根 `package.json` 的 `dsh.bundle.patch`（已具备）。
3. OpenCode 无官方市场，可向 awesome-opencode 提 PR。

## 7. 安全

- 若凭据曾在聊天、日志或截图中暴露，请撤销并重新生成；不要把 `.npmrc`、API Key 或 recovery codes 贴进 issue/PR。
- 不要提交 `~/.npmrc`、`~/.config/opencode/ds-saver.json`、`~/.config/opencode/ds-saver.env`。
- 插件 `tree` / `rag` / `misc` 拒绝 `03-密钥`、`.env*`、`auth.json`、私钥等路径；材料命中密钥模式会中止；`rag filter` 外发前再过一次 `assertNoSecrets`。
- `ctx_report` 只写本地匿名 JSONL，不自动联网。

## 8. 后续 TODO

1. 等 npm 临时暂停解除，发布 `0.4.0`（含一键安装包；OTP 或 granular token）。
2. 发布后复核 DSH Hub 自动同步结果；必要时手动提交。
3. 给 DSH 插件补 `locale/en.json`、`locale/zh.json` 与 icon，让插件页显示正确标题/描述（当前用默认图标）。
4. 视需要把 `rag filter` 的候选上下文抽成可配置项（行数、字符数）。
5. 给 `misc` 在 DSH 上补一份插件内 `Config`，让用户不必依赖 `~/.config/opencode/ds-saver.json`。
