# DSH 适配说明（双端发布）

调研时间：2026-11-26。目标：同一个 npm 包同时作为 OpenCode 插件和 DeepSeek Harness（DSH）插件发布。

## 结论

可行且不冲突。DSH 只加载 `cordis.patch.yml` 里 `name` 指向的子路径；OpenCode 只解析 `exports["./server"]` 或 `exports["."]`。两边互不读取对方的入口。

- OpenCode 入口：`exports["."]` → `./index.js`（`Plugin.define({ id, setup })`）
- DSH 入口：`exports["./dsh"]` → `./dsh/index.js`（Cordis 具名导出 `name` / `inject` / `apply`）
- 补丁：`cordis.patch.yml` 里写 `name: 'ds-saver/dsh'`

## package.json 需要的字段

```jsonc
{
  "name": "ds-saver",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./dsh": "./dsh/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "dsh", "cordis.patch.yml", "README.md", "LICENSE"],
  "engines": {
    "node": ">=20",
    "dsh": ">=0.2.2-rc.5 <0.3.0-0"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "0.2.2-rc.5",
    "@deepseek-ai/cordis": "~4.1.0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-tools": { "optional": true },
    "@deepseek-ai/cordis": { "optional": true }
  }
}
```

`engines.dsh` 会被真正校验；DSH 处于 preview，版本区间要写死。

## DSH 入口最小形态

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ds-saver'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'tree',
    description: 'Compact directory tree with secret-path filtering.',
    parameters: {
      path: { type: 'string', description: 'Directory, defaults to cwd' },
      depth: { type: 'number', description: 'Max depth, default 3' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return collectTree(args) // 来自 src/core，必须处理 exec.signal
    },
  }))
}
```

与 OpenCode 的差异：

| | OpenCode | DSH |
|---|---|---|
| 入口 | `Plugin.define({ id, setup })` | 具名 `name` / `inject` / `apply` |
| 注册 | `ctx.tool.transform(e => e.add(...))` | `ctx.tools.register(defineTool(...))` |
| 参数 | 标准 JSON Schema `input` | `parameters` DSL（`required: true`） |
| 返回 | `{ content }` | 符合 `output.schema` 的单个 JSON 值 |

因此纯逻辑要抽到 `src/core.js`，两个入口只做注册映射。

## 双端能力差异

| 工具 | OpenCode | DSH | 说明 |
|---|---|---|---|
| `misc` | ✅ | ✅ | 只依赖配置与 fetch |
| `tree` | ✅ | ✅ | 纯本地 |
| `rag` | ✅ | ✅ | 纯本地 / 外部命令 |
| `handoff` | ✅ | ✅ | 写 markdown，路径可配置 |
| `ctx_status` | ✅ | ❌ | 依赖 OpenCode 的 `ctx-usage.py` 与会话库 |
| `ctx_forecast` | ✅ | ❌ | 依赖 OpenCode 会话 token 数据 |
| `ctx_calibrate` | ✅ | ❌ | 依赖 forecast 快照 |
| `ctx_report` | ✅ | ⚠️ | 只能采 DSH 侧可用字段 |

DSH 端首版建议只注册 `misc` / `tree` / `rag` / `handoff`，README 里明确写「OpenCode 专属工具在 DSH 不可用」。

## 发布与收录

1. 预编译到 `dist/`（DSH CLI 不带 TS 运行时；当前项目是纯 JS，可直接发 `index.js` 与 `dsh/`）。
2. `npm publish --access public`。
3. GitHub topics：`dsh-plugin`、`deepseek-harness`、`opencode-plugin`。
4. DSH Hub：<https://dsh-hub.cc/publish> 用 GitHub 登录，提交 repo 或 npm 包；服务端检查根 `package.json` 的 `dsh.bundle.patch`。
5. OpenCode：无官方市场；靠 npm keyword 被第三方索引，或向 awesome-opencode 提 PR（`data/plugins/<name>.yaml`）。

## 风险

- DSH 仍是 developer preview，API 可能破坏性变更。
- `@deepseek-ai/dsh-tools` 的 npm `latest` 标签目前指向 `0.0.1-rc.1`，必须写死 `0.2.2-rc.5` 或使用 `next`。
- 本机未安装 `dsh`，DSH 入口只能做静态检查，无法本机 `apply` 实测。
- 子路径入口的 icon/locale 需要额外导出 `./dsh/icon`、`./dsh/locale/*.json`，首版可省略。
