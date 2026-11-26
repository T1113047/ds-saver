# 子 agent 低思考（reasoning effort）配置

结论：**可以，而且值得做，但不要一刀切。**

DeepSeek V4.1 Flash 官方 API 支持 `reasoning_effort: "none" | "low" | "high" | "max"`，默认 `high`；也可以用 `thinking: { type: "disabled" }` 关闭。OpenCode 2.4.x 通过模型的 **variant** 暴露这组参数，agent 的 `model` 字段可以写 `provider/model#variant`。

## 1. 给模型定义变体

在 `~/.config/opencode/opencode.jsonc` 增加（不要动其它已有字段）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "deepseek": {
      "models": {
        "deepseek-flash": {
          "variants": [
            { "id": "low",  "settings": { "reasoningEffort": "low" } },
            { "id": "none", "settings": { "reasoningEffort": "none" } }
          ]
        }
      }
    }
  }
}
```

`reasoningEffort` 会被 OpenCode 映射成请求体的 `reasoning_effort`。`none` 等价于关闭思考，最省钱，但复杂判断容易退化。

## 2. 给子 agent 指定变体

文件式 agent：`~/.config/opencode/agents/explore-low.md`

```md
---
description: 只读检索与文档整理，低思考
mode: subagent
model: deepseek/deepseek-flash#low
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---
只做检索、摘录、整理。不要改文件，不要执行命令。
```

或 JSONC：

```jsonc
{
  "agents": {
    "docs-runner": {
      "description": "整理文档、筛选输出、调用只读工具",
      "mode": "subagent",
      "model": "deepseek/deepseek-flash#low",
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

## 3. 推荐分配

| 子 agent 用途 | 建议 | 原因 |
|---|---|---|
| 目录树、grep、读文件、摘录、文档整理 | `#low` 或 `#none` | 任务是检索与转述，不需要长推理 |
| 调用固定工具、批量分类、格式化 | `#none` | 规则明确，思考只会增加输出 token |
| 多文件重构、排障、设计取舍 | 默认 `high` | `low` 容易漏边界条件，返工更贵 |
| 代码审查 | `#high` | 需要发现隐含回归 |

## 4. 注意

- 子 agent 不配置 `model` 时继承父会话模型与变体；父会话是 `high`，子 agent 也是 `high`。
- `#none` 仍会返回 `reasoning_content` 字段（可能为空），OpenCode 已兼容。
- 变体只改请求参数，不改 prompt 前缀，正常不影响 DeepSeek 的缓存命中；但思考变短会改变后续消息内容，缓存收益要按实际消息算。
- 官方文档：<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- OpenCode 变体文档：<https://opencode.ai/docs/models#variants>
