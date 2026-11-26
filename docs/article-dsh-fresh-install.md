# 把 ds-saver 装进全新的 DSH：一次真实的插件适配记录

> 2026-11-26 · DSH `0.2.2-rc.5` · Windows 11 · Node 24

`ds-saver` 最早是给 OpenCode 写的上下文节约插件：用便宜模型筛工具输出、预测换窗时机、在质量拐点生成 handoff。后来我们把同一份包做成双端插件——OpenCode 走 `Plugin.define`，DSH 走 Cordis 的 `name / inject / apply`。

OpenCode 端早就跑通了。DSH 端代码写完，但一直没在真机上跑过。这次的目标很明确：**不在我改过的 profile 上测，而是从零新建一个 profile，用官方安装命令装，再让模型真的把工具调一遍。**

结果第一次安装就翻车了。这篇记录把问题、修法和实测结果完整写下来。

## 一、全新环境怎么搭

为了不污染日常使用的 Desktop profile，我用临时 `DSH_HOME` 和全新 profile：

```sh
dsh --profile headless-fresh --from-default-profile headless
```

然后走官方安装路径：

```sh
dsh plugin --profile headless-fresh add <ds-saver 目录>
```

安装本身成功了，但 pnpm 给了一条很容易被忽略的警告：

```text
[WARN] The package ds-saver, which you have just pnpm linked, has the following
peerDependencies specified in its package.json:
  - @deepseek-ai/dsh-tools@0.2.2-rc.5, @deepseek-ai/cordis@~4.1.0

The linked in dependency will not resolve the peer dependencies from the
target node_modules.
```

当时的适配层正是这样写的：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
```

于是模块导入直接失败：

```text
dsh: error: [/101] Cannot find package '@deepseek-ai/dsh-tools'
  imported from ...\ds-saver-repo\dsh\index.js
```

## 二、根因不是版本，是解析边界

DSH 的运行时解析会覆盖安装目录和 profile 里的 bundle，但**不会替一个 linked 的第三方包解析它的 peerDependencies**。插件代码在 `C:\code\...\ds-saver-repo` 下，Node 从那里往上找 `node_modules`，自然找不到 DSH 安装目录里的 `@deepseek-ai/dsh-tools`。

这不是 ds-saver 独有的问题。任何第三方 DSH 插件，只要：

- 声明了 `@deepseek-ai/dsh-tools` 之类的 peer；
- 又通过本地目录、`link:`、或者某些 npm 安装方式注入；

就会踩到同一堵墙。官方文档对“随 DSH 安装的包优先解析”的描述，主要覆盖 DSH 自己的 bundle，不覆盖外部插件的 peer 解析。

## 三、修法：把 `defineTool` 变成零依赖

`defineTool` 做的事情其实不神秘：

1. 把作者侧参数 DSL 编译成原始 JSON Schema；
2. 把输出 schema 编译成原始 JSON Schema；
3. 在 `execute` 前校验模型参数。

这三步都不需要引用 DSH 包。`ctx.tools.register` 接受的本来就是 `{ name, description, parameters, output: { schema, render }, execute }` 这样的普通对象。

所以 0.2.1 里，`dsh/index.js` 内置了一个等价实现 `defineDshTool`：

- 覆盖 `string` / `number` / `integer` / `boolean` / `array` / `object` / `oneOf` / `json`；
- `required: true` 收进根 `required`；
- 校验类型、必填、`enum` / `const`；
- 参数在 `execute` 前校验，非法参数抛 `ToolArgsError`。

同时移除了不再使用的 `@deepseek-ai/*` peerDependencies。`engines.dsh` 仍然钉死版本区间，兼容性检查不受影响。

修完之后再跑 schema dump：

```sh
dsh --profile headless-fresh --dump-config-schema
# exit 0，ds-saver 行 status: absent（没有 Config schema，符合预期）
```

`--dump-config` 里也出现了正确的行：

```yaml
# == ds-saver
- id: ds-saver
  name: ds-saver/dsh
```

## 四、让模型真的调用一次

配置能加载不等于工具能用。于是每个工具开一个真实 headless 会话，让模型主动调用：

| 工具 | 结果 |
|---|---|
| `tree` | 输出 `TREE_OK` + 目录树前三行 |
| `rag` | 检索 `export const core`，输出 `RAG_OK` |
| `handoff` | 生成 `.handoff/handoff-20261126-235601-dsh-实测通过.md`（301 B） |
| `misc` | 用自定义便宜 provider 总结材料，输出 `MISC_OK` |

`misc` 的 provider 是临时配置的 Qwen Token Plan 兼容端点，说明“换 baseURL + model + key”的链路在 DSH 上同样成立。`tree` / `rag` / `handoff` 甚至不需要任何密钥。

完整记录（含命令、版本、失败信息）放在仓库的 [`docs/dsh-verification.md`](../docs/dsh-verification.md)。

## 五、现在怎么装

npm 发布后：

```sh
dsh plugin --profile <profile> add ds-saver
```

本地目录开发：

```sh
dsh plugin --profile <profile> add /path/to/ds-saver
```

Desktop 版也可以在 **设置 → 插件** 里添加本地目录或 npm 包。

装完的 DSH 端有四个工具：`misc`、`tree`、`rag`、`handoff`。OpenCode 专属的 `ctx_status`、`ctx_forecast`、`ctx_calibrate`、`ctx_report` 依赖 OpenCode 会话库，在 DSH 不注册。

## 六、还没做完的

- **GUI 视觉验收**：当前只在 CLI/宿主侧验证了安装、导入、执行；Desktop 插件页的图标与详情页还没有浏览器级截图验证。
- **DSH 仍是 preview**：`ctx.tools.register` 的契约、参数 schema 投影都可能继续变；零依赖实现降低了对 `@deepseek-ai/dsh-tools` 的耦合，但如果未来要求包内类实例，需要重新评估。
- **`misc` 配置**：DSH 用户需要自己准备便宜模型的 key；`tree` / `rag` / `handoff` 无此要求。
- **Windows 测试回归**：顺手修了 smoke 测试里用模板字符串拼 JSON 导致路径反斜杠非法转义的问题，现在 Node 20/22/24 + Windows 都能跑。

## 小结

这次真正有价值的不是“插件能装”，而是找到了第三方 DSH 插件最容易踩的解析边界，并把依赖降到了零。对插件作者来说，**不要 import 你不拥有的运行时包**，至少在 DSH preview 阶段如此；把用到的几十行 helper 拿进自己的包里，比赌 peer 解析可靠得多。

## 附：0.3.0 的 `rag filter`

发布前又补了一个很实用的能力：本地检索不再把所有命中一股脑塞给主模型，而是先取最多 12 条候选（命中行前后各 2 行、约 800 字符/条），交给便宜模型输出 JSON 筛选结果，插件再校验路径/行号必须落在候选集合内，只注入 3–5 条 `文件:行号 — 摘要（理由）`，末尾附 `picked N / candidates M`。

```text
rag(query="重试逻辑在哪", path="src", filter=true, filter_topK=5, model="hy4")
```

无 key、HTTP 错误、JSON 非法、筛选结果为空都会自动回退原始命中，metadata 标记 `filter_fallback` / `filter_error`，不会中断主流程；`filter=true` 会强制走内置检索，保证拿到结构化路径与行号。这一步本质上就是“先用子 agent 筛内容，再注入主 LLM”，只是把子 agent 换成了更便宜的独立模型调用。

在全新 DSH 上实测：`picked 2 / candidates 2`，两条都带摘要与命中理由。

仓库：<https://github.com/T1113047/ds-saver>

