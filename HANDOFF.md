# ds-saver 交接报告

> 更新：2026-11-27  
> 项目：DS节约插件（npm / GitHub 名：`ds-saver`）  
> 目标：在 OpenCode 与 DeepSeek Harness (DSH) 双端提供上下文/成本节约能力。

## 1. 一句话状态

OpenCode 端与 DSH 端都已完成实机验证；`0.3.0` 源码已推送到 GitHub `main`；npm 发布**被账号临时安全暂停卡住**（不是包本身的问题）。

- GitHub：<https://github.com/T1113047/ds-saver>（`main` = `2412984`，0.3.0）
- npm：`ds-saver@0.3.0` 已打包（19 files / 58.0 kB），**未发布**
- 第三方库：仓库已有 `dsh-plugin` topic，DSH Hub 会按 topic 自动同步（待 npm 可装后复核）
- 本地 tarball：`ds-saver-0.3.0.tgz`（在仓库根目录，已 gitignore）

## 2. 这次做了什么

1. **DSH 全新 profile 实测**：临时 `DSH_HOME` + `headless-fresh`，官方 `dsh plugin add` 安装；`tree` / `rag` / `misc` / `handoff` 四工具被模型实际调用成功。
2. **修掉 DSH 导入阻塞**：`dsh/index.js` 原 `import '@deepseek-ai/dsh-tools'` 在 linked 安装下必然失败（`Cannot find package`）。改为内置 `defineDshTool`（参数 DSL → 原始 JSON Schema + 参数校验），移除 `@deepseek-ai/*` peerDependencies。
3. **0.3.0 `rag filter`**：检索候选（最多 12 条、命中行前后 2 行、约 800 字符/条）→ 便宜模型输出 JSON 选择 → 校验路径/行号必须落在候选内 → 只注入 3–5 条 `文件:行号 — 摘要（理由）`，附 `picked N / candidates M`；失败自动回退原始命中。
4. **Windows 测试回归**：smoke 测试里用模板字符串拼 JSON 导致路径反斜杠非法转义，改为 `JSON.stringify`。
5. **文档/文章**：`docs/dsh-verification.md`、`docs/dsh-adapter.md`、`docs/article-dsh-fresh-install.md`。

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

背景：账号 `t_yh` 原本 `tfa=false`，npm 仍要求 2FA/带 bypass 的 granular token；在网页开启 2FA 后触发临时安全暂停。恢复后二选一：

1. 用 OTP 发布：`npm publish --access public --otp=<6位>`；
2. 创建 granular access token（publish + bypass 2FA）后 `NPM_TOKEN=... npm publish --access public`。

发布后立刻验证：`npm view ds-saver version` → `0.3.0`。

### DSH Hub / 第三方库

1. 仓库已有 topics：`dsh-plugin`、`deepseek-harness`、`opencode-plugin`；Hub 会按 `dsh-plugin` 自动同步。
2. 也可在恢复后到 <https://dsh-hub.cc/publish> 用 GitHub 登录提交 repo 或 npm 包；服务端检查根 `package.json` 的 `dsh.bundle.patch`（已具备）。
3. OpenCode 无官方市场，可向 awesome-opencode 提 PR。

## 7. 安全

- **本次曾在对话中贴过 GitHub PAT 和 npm 恢复码**：请撤销 PAT、重新生成 npm recovery codes；npm 登录 token 已删/待删。
- 不要提交 `~/.npmrc`、`~/.config/opencode/ds-saver.json`、`~/.config/opencode/ds-saver.env`。
- 插件 `tree` / `rag` / `misc` 拒绝 `03-密钥`、`.env*`、`auth.json`、私钥等路径；材料命中密钥模式会中止；`rag filter` 外发前再过一次 `assertNoSecrets`。
- `ctx_report` 只写本地匿名 JSONL，不自动联网。

## 8. 后续 TODO

1. 等 npm 临时暂停解除，发布 `0.3.0`（OTP 或 granular token）。
2. 发布后复核 DSH Hub 自动同步结果；必要时手动提交。
3. 给 DSH 插件补 `locale/en.json`、`locale/zh.json` 与 icon，让插件页显示正确标题/描述（当前用默认图标）。
4. 视需要把 `rag filter` 的候选上下文抽成可配置项（行数、字符数）。
5. 给 `misc` 在 DSH 上补一份插件内 `Config`，让用户不必依赖 `~/.config/opencode/ds-saver.json`。
