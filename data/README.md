# 公开数据

这个目录只放**聚合数据**，用于插件页、阈值校准和复现。

- `deepseek-context-2026-11-26.json`：18,471 条 DeepSeek assistant 消息、67 个长会话的聚合统计。

## 包含什么

- 上下文分布、C/R（上下文/思维链）分位
- tool / reasoning / text 的字节占比
- 各上下文区间的工具错误、助手错误、重试、输出、耗时、成本
- 会话内前后半段对比
- 最终上下文分位与阈值覆盖
- 新会话首请求注入成本（`new_session_injection`）
- 动态预测的 base 常数与历史校验（`forecast_model`）
- 推荐 profile（300/500/650/800K）

## 不包含什么

- 提示词、模型输出正文、代码
- 会话标题、session ID、文件路径
- IP、账号、密钥、任何凭据

## 复现

```sh
python3 scripts/measure-context.py
```

## 反馈

插件里的 `ctx_report` 会写一条本地匿名指标到：

```
~/.local/share/opencode/ds-saver/metrics.jsonl
```

字段只有：session hash、模型、消息数、上下文、累计思维链、C/R、组成占比、政策档位、成本。  
不含提示词、正文、路径、密钥。是否提交到 issue 完全由用户决定。

## 许可

聚合数据建议使用 CC BY 4.0；代码使用仓库根目录的 LICENSE。
