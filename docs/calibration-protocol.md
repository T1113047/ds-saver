# 校准协议：预测偏差过大时，让 agent 现场更新

> 适用：`ctx_forecast` 的预测与真实会话偏差超过阈值。  
> 目标：不手动改阈值，而是把「最近一次预测快照 + 实际值」交给校准 agent，重算 growth/base 范围，写一份交接文档；下一次 `ctx_forecast` 自动读取。

---

## 1. 触发条件

`ctx_forecast` 会写一份预测快照：

```
~/.local/share/opencode/ds-saver/last-forecast.json
```

出现以下任一情况，调用 `ctx_calibrate`：

| 偏差 | 阈值（默认） | 说明 |
|---|---:|---|
| 上下文预测 vs 实际 | **> 50%** | 经过 N 轮后，实际上下文与预测差太多 |
| 新会话首请求预测 vs 实际 | **> 50%** | 换窗后实际注入与预测差太多 |
| 到 500K 的轮次预测 vs 实际 | **> 50%** | 轮次预测明显偏快/偏慢 |

阈值可通过 `threshold_pct` 调整，但**不要为了“看起来准”手动改**；先积累样本。

---

## 2. 调用方式

主 LLM 可以直接调用：

```text
ctx_calibrate(
  actual_turns=20,
  actual_context=620000,
  actual_next_prompt=11200,
  actual_turns_to_500k=35,
  threshold_pct=50,
  explain=true
)
```

参数：

| 参数 | 含义 |
|---|---|
| `actual_turns` | 距上次预测经过的 assistant 轮数；省略则用消息数差 |
| `actual_context` | 实际上下文 token；省略则取当前会话 |
| `actual_next_prompt` | 新会话首请求实际 prompt token（可选） |
| `actual_turns_to_500k` | 实际到 500K 的轮次（可选） |
| `threshold_pct` | 触发阈值，默认 50 |
| `explain` | true 时用 Qwen3.8 Flash 写 5 行校准交接 |

---

## 3. 校准数学

```text
old_G       = 上次预测的 growth p50
observed_G  = (C_actual - C_forecast) / actual_turns
multiplier  = clamp(observed_G / old_G, 0.5, 2.0)

new_G       = old_G × multiplier
base_p50    = actual_next_prompt - handoff_tokens - task_data_tokens
base_p90    = base_p50 × (old_p90 / old_p50)

new_turns(t)= (t - C_actual) / new_G
```

- `multiplier > 1`：实际涨得比预测快 → 新范围更短。
- `multiplier < 1`：实际涨得慢 → 新范围更长。
- 只更新 `growth_multiplier` 和可选的 `base`；**不改 300/500/650/800K 阈值本身**。
- `multiplier` 被限制在 **0.5–2.0**。如果原始比值超出这个范围，输出 `saturated: true`，并明确提示：**轮次预测不可信，按绝对阈值行动**。
- 数学是确定性的；Qwen3.8 Flash 只负责写交接说明，不参与算数，避免幻觉阈值。

---

## 4. 输出

写两个文件（600）：

```
~/.local/share/opencode/ds-saver/calibration/latest.json
~/.local/share/opencode/ds-saver/calibration/calibration-YYYYMMDD-HHMMSS.md
```

`latest.json`：

```json
{
  "schema": 1,
  "source": "ctx_calibrate",
  "growth_multiplier": 1.32,
  "saturated": false,
  "observed_growth": 2400,
  "base": { "prompt_p50": 9800, "prompt_p90": 14200 },
  "deviation": {
    "context_pct": 62.5,
    "prompt_pct": 8.1,
    "turns_pct": 41.0,
    "max_pct": 62.5,
    "threshold_pct": 50
  },
  "growth": { "p25": 1200, "p50": 2400, "p75": 3600 },
  "ranges": {
    "soft":    { "fast": 12, "mid": 18, "slow": 30 },
    "handoff": { "fast": 20, "mid": 30, "slow": 52 },
    "hard":    { "fast": 38, "mid": 56, "slow": 95 },
    "max":     { "fast": 52, "mid": 78, "slow": 130 }
  },
  "doc": ".../calibration-20261126-220000.md",
  "agent_note": "Qwen3.8 Flash 写的 5 行交接"
}
```

交接文档结构：

1. **偏差**：预测上下文 / 实际上下文 / 误差；下次注入误差；轮次误差。
2. **新参数**：growth multiplier、growth p25/p50/p75、base prompt、新范围。
3. **Agent 交接**：Qwen 5 行（结论/原因/新范围/风险/下一步）。
4. **应用**：下一次 `ctx_forecast` 自动读取 `latest.json`；若仍有偏差，再校准一次。

---

## 5. Agent 交接模板

`explain=true` 时，Qwen3.8 Flash 收到的提示：

```text
你是上下文校准 agent。根据下面的偏差与重算参数，写 5 行中文交接文档：
1 结论；2 偏差原因；3 新范围；4 风险；5 下一步。不要编造数字。
<deviation + calibration JSON>
```

没有 DashScope key 时，`ctx_calibrate` 仍会写确定性交接文档，`agent_note` 标注“Qwen 未配置”。

---

## 6. 闭环

```text
ctx_forecast
  ├─ 写 last-forecast.json
  ├─ 预测 turns / next prompt / cost
  ↓
实际使用 10–20 轮
  ↓
偏差 > 50% ?
  ├─ 否：继续用原范围
  └─ 是：ctx_calibrate
        ├─ 读 last-forecast.json
        ├─ 重算 growth_multiplier + base
        ├─ 写 calibration/latest.json + calibration-*.md
        ├─ Qwen3.8 Flash 写 5 行交接
        ↓
   ctx_forecast 自动读取 latest.json
        ↓
   用新 multiplier/base 重新预测
```

---

## 7. 示例：一次真实偏差

假设：

- 上次预测：从 420K 出发，`G50=1,900`，到 500K 约 42 轮；下次首请求 9,000 token。
- 实际：20 轮后上下文 620K；新会话首请求 11,200 token。

计算：

```text
observed_G = (620000 - 420000) / 20 = 10,000
multiplier = 10,000 / 1,900 ≈ 5.26 → clamp 2.0
new_G      = 1,900 × 2.0 = 3,800
base_p50   = 11,200 - 600 - 3,000 = 7,600
```

结论：实际涨得比预测快得多，`multiplier` 被上限 2.0 截断；新范围会明显缩短，同时提示“预测模型已饱和，建议直接按实际阈值换窗”。

> 这个例子说明：当 `multiplier` 触到 2.0 上限，不要继续相信轮次预测，直接按 300/500/650K 绝对阈值行动，并补更多样本。

---

## 8. 数据与隐私

- `last-forecast.json` 与 `calibration/latest.json` 只含 token、比例、成本、session hash。
- 不含提示词、正文、代码、路径、密钥。
- Qwen 解释只发送校准 JSON，不发送原始会话。
- 这些文件在 600 权限下，且 `.gitignore` 已排除。
