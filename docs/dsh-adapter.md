# DSH 适配说明（双端发布）

调研时间：2026-11-26；实机验证：2026-11-26（DSH `0.2.2-rc.5`）。目标：同一个 npm 包同时作为 OpenCode 插件和 DeepSeek Harness（DSH）插件发布。

## 结论

可行且不冲突。DSH 只加载 `cordis.patch.yml` 里 `name` 指向的子路径；OpenCode 只解析 `exports["."]`。两边互不读取对方的入口。

- OpenCode 入口：`exports["."]` → `./index.js`（`Plugin.define({ id, setup })`）
- DSH 入口：`exports["./dsh"]` → `./dsh/index.js`（Cordis 具名导出 `name` / `inject` / `apply`）
- 补丁：`cordis.patch.yml` 里写 `name: 'ds-saver/dsh'`
- DSH 入口**不 import 任何 `@deepseek-ai/*` 包**（原因见下）

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
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`engines.dsh` 会被真正校验；DSH 处于 preview，版本区间要写死。

> 注意：不要在 `dsh/index.js` 里 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
> 第三方插件通常用 `link:` / 本地目录 / npm 安装；Node 只从插件自身与 profile 的
> `node_modules` 解析，不会去 DSH 安装目录解析该 peer。pnpm 会明确警告：
> “The linked in dependency will not resolve the peer dependencies from the target node_modules.”
> 首版实测就是这个错误（`Cannot find package '@deepseek-ai/dsh-tools'`），已在 0.2.1 改为内置
> `defineDshTool`。

## DSH 入口最小形态

```js
export const name = 'ds-saver'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'tree',
    description: 'Compact directory tree with secret-path filtering.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory, defaults to cwd' },
        depth: { type: 'number', description: 'Max depth, default 3' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return collectTree(args)
    },
  })
}
```

`ctx.tools.register` 接受 **原始 JSON Schema** 形式的 `parameters`。`defineTool` 只是把作者侧 DSL
编译成同样的结构并在 `execute` 前做参数校验；第三方插件可以自己完成这一步，避免依赖解析问题。
`ds-saver` 的 `dsh/index.js` 内置了一个最小实现，覆盖 string / number / integer / boolean /
array / object / oneOf / json 与 `required: true`。

与 OpenCode 的差异：

| | OpenCode | DSH |
|---|---|---|
| 入口 | `Plugin.define({ id, setup })` | 具名 `name` / `inject` / `apply` |
| 注册 | `ctx.tool.transform(e => e.add(...))` | `ctx.tools.register(definition)` |
| 参数 | 标准 JSON Schema `input` | 标准 JSON Schema `parameters`（或自行编译 DSL） |
| 返回 | `{ content }` | 符合 `output.schema` 的单个 JSON 值 |
| 取消 | `toolCtx` | `exec.signal`（必须协作式观察） |

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

## 实机验证（0.2.1）

在全新 headless profile 上：

```text
dsh --profile headless-fresh --from-default-profile headless
dsh plugin --profile headless-fresh add <ds-saver 目录>
dsh --profile headless-fresh --dump-config        # 出现 - id: ds-saver / name: ds-saver/dsh
dsh --profile headless-fresh --dump-config-schema # 退出码 0，模块导入成功
dsh --profile headless-fresh "调用 tree/rag/misc/handoff"
```

四个工具均由模型实际调用成功；`handoff` 成功落盘。详见 [`dsh-verification.md`](dsh-verification.md)。

## 发布与收录

1. 纯 JS，不需要构建；`files` 里带 `dsh/` 与 `cordis.patch.yml`。
2. `npm publish --access public`。
3. GitHub topics：`dsh-plugin`、`deepseek-harness`、`opencode-plugin`（DSH Hub 会按 `dsh-plugin` topic 自动同步）。
4. DSH Hub：<https://dsh-hub.cc/publish> 用 GitHub 登录后提交 repo 或 npm 包；服务端检查根 `package.json` 的 `dsh.bundle.patch`。
5. OpenCode 无官方市场；靠 npm keyword 被第三方索引，或向 awesome-opencode 提 PR。

## 风险

- DSH 仍是 developer preview，API 可能破坏性变更。
- `@deepseek-ai/dsh-tools` 已不是本插件的依赖；如果未来 `ctx.tools.register` 改为要求包内类实例，需要重新评估。
- 子路径入口的 icon/locale 需要额外导出 `./dsh/icon`、`./dsh/locale/*.json`；首版省略，插件在 DSH 插件页使用默认图标。
